import { BehaviorSubject, combineLatest, Observable, Unsubscribable } from 'rxjs'
import { distinctUntilChanged, map } from 'rxjs/operators'
import {
    ActionItem,
    CommandContribution,
    ContributableMenu,
    Contributions,
    MenuContributions,
    MenuItemContribution,
} from '../../protocol'
import { isEqual } from '../../util'
import { Context, createChildContext, MutableContext } from '../context/context'
import { evaluate, evaluateTemplate } from '../context/expr/evaluator'
import { TEMPLATE_BEGIN } from '../context/expr/lexer'

/** A registered set of contributions from an extension in the registry. */
export interface ContributionsEntry {
    /** The contributions. */
    contributions: Contributions
}

/**
 * An unsubscribable that deregisters the contributions it is associated with. It can also be used in
 * ContributionRegistry#replaceContributions.
 */
export interface ContributionUnsubscribable extends Unsubscribable {
    entry: ContributionsEntry
}

/** Manages and executes contributions from all extensions. */
export class ContributionRegistry {
    /** All entries, including entries that are not enabled in the current context. */
    private _entries = new BehaviorSubject<ContributionsEntry[]>([])

    public constructor(private context: Observable<Context>) {}

    /** Register contributions and return an unsubscribable that deregisters the contributions. */
    public registerContributions(entry: ContributionsEntry): ContributionUnsubscribable {
        this._entries.next([...this._entries.value, entry])
        return {
            unsubscribe: () => {
                this._entries.next(this._entries.value.filter(e => e !== entry))
            },
            entry,
        }
    }

    /**
     * Atomically deregister the previous contributions and register the next contributions. The registry's observable
     * emits only one time after both operations are complete (instead of also emitting after the deregistration
     * and before the registration).
     */
    public replaceContributions(
        previous: ContributionUnsubscribable,
        next: ContributionsEntry
    ): ContributionUnsubscribable {
        this._entries.next([...this._entries.value.filter(e => e !== previous.entry), next])
        return {
            unsubscribe: () => {
                this._entries.next(this._entries.value.filter(e => e !== next))
            },
            entry: next,
        }
    }

    /**
     * All contributions (merged) that are enabled for the current context, emitted whenever the set changes.
     */
    public readonly contributions: Observable<Contributions> = this.getContributions(this._entries)

    protected getContributions(entries: Observable<ContributionsEntry[]>): Observable<Contributions> {
        return combineLatest(entries, this.context).pipe(
            map(([entries, context]) =>
                entries.map(({ contributions }) => {
                    try {
                        return evaluateContributions(context, filterContributions(context, contributions))
                    } catch (err) {
                        // An error during evaluation causes all of the contributions in the same entry to be
                        // discarded.
                        console.error('Discarding contributions: evaluating expressions or templates failed.', {
                            contributions,
                            err,
                        })
                        return {}
                    }
                })
            ),
            map(c => mergeContributions(c)),
            distinctUntilChanged((a, b) => isEqual(a, b))
        )
    }

    /**
     * All contribution entries, emitted whenever the set of registered contributions changes.
     *
     * Most callers should use ContributionsRegistry#contributions. Only use #entries if the caller needs
     * information that is discarded when the contributions are merged (such as the extension that registered each
     * set of contributions).
     */
    public readonly entries: Observable<ContributionsEntry[]> & { value: ContributionsEntry[] } = this._entries
}

/**
 * Merges the contributions.
 *
 * Most callers should use ContributionRegistry's contributions field, which merges all registered contributions.
 */
export function mergeContributions(contributions: Contributions[]): Contributions {
    if (contributions.length === 0) {
        return {}
    }
    if (contributions.length === 1) {
        return contributions[0]
    }
    const merged: Contributions = {}
    for (const c of contributions) {
        if (c.commands) {
            if (!merged.commands) {
                merged.commands = [...c.commands]
            } else {
                merged.commands = [...merged.commands, ...c.commands]
            }
        }
        if (c.menus) {
            if (!merged.menus) {
                merged.menus = { ...c.menus }
            } else {
                for (const [menu, items] of Object.entries(c.menus) as [ContributableMenu, MenuItemContribution[]][]) {
                    if (!merged.menus[menu]) {
                        merged.menus[menu] = [...items]
                    } else {
                        merged.menus[menu] = [...merged.menus[menu]!, ...items]
                    }
                }
            }
        }
    }
    return merged
}

/** Filters out items whose `when` context expression evaluates to false (or a falsey value). */
export function contextFilter<T extends { when?: string }>(context: Context, items: T[], evaluateExpr = evaluate): T[] {
    const keep: T[] = []
    for (const item of items) {
        if (item.when !== undefined && !evaluateExpr(item.when, createChildContext(context))) {
            continue // omit
        }
        keep.push(item)
    }
    return keep
}

/** Filters the contributions to only those that are enabled in the current context. */
export function filterContributions(
    context: Context,
    contributions: Contributions,
    evaluateExpr = evaluate
): Contributions {
    if (!contributions.menus) {
        return contributions
    }
    const filteredMenus: MenuContributions = {}
    for (const [menu, items] of Object.entries(contributions.menus) as [ContributableMenu, MenuItemContribution[]][]) {
        filteredMenus[menu] = contextFilter(context, items, evaluateExpr)
    }
    return { ...contributions, menus: filteredMenus }
}

const DEFAULT_TEMPLATE_EVALUATOR: {
    evaluateTemplate: (template: string, context: MutableContext) => any

    /**
     * Reports whether the string needs evaluation. Skipping evaluation for strings where it is unnecessary is an
     * optimization.
     */
    needsEvaluation: (template: string) => boolean
} = {
    evaluateTemplate,
    needsEvaluation: (template: string) => template.includes(TEMPLATE_BEGIN),
}

/**
 * Evaluates expressions in contribution definitions against the given context.
 */
export function evaluateContributions(
    context: Context,
    contributions: Contributions,
    { evaluateTemplate, needsEvaluation } = DEFAULT_TEMPLATE_EVALUATOR
): Contributions {
    if (!contributions.commands || contributions.commands.length === 0) {
        return contributions
    }
    const evaluatedCommands: CommandContribution[] = []
    for (const command of contributions.commands as Readonly<CommandContribution>[]) {
        const childContext = createChildContext(context)
        const changed: Partial<CommandContribution> = {}
        if (command.title && needsEvaluation(command.title)) {
            changed.title = evaluateTemplate(command.title, childContext)
        }
        if (command.category && needsEvaluation(command.category)) {
            changed.category = evaluateTemplate(command.category, childContext)
        }
        if (command.description && needsEvaluation(command.description)) {
            changed.description = evaluateTemplate(command.description, childContext)
        }
        if (command.iconURL && needsEvaluation(command.iconURL)) {
            changed.iconURL = evaluateTemplate(command.iconURL, childContext)
        }
        if (command.actionItem) {
            const changedActionItem: Partial<ActionItem> = {}
            if (command.actionItem.label && needsEvaluation(command.actionItem.label)) {
                changedActionItem.label = evaluateTemplate(command.actionItem.label, childContext)
            }
            if (command.actionItem.description && needsEvaluation(command.actionItem.description)) {
                changedActionItem.description = evaluateTemplate(command.actionItem.description, childContext)
            }
            if (command.actionItem.group && needsEvaluation(command.actionItem.group)) {
                changedActionItem.group = evaluateTemplate(command.actionItem.group, childContext)
            }
            if (command.actionItem.iconURL && needsEvaluation(command.actionItem.iconURL)) {
                changedActionItem.iconURL = evaluateTemplate(command.actionItem.iconURL, childContext)
            }
            if (command.actionItem.iconDescription && needsEvaluation(command.actionItem.iconDescription)) {
                changedActionItem.iconDescription = evaluateTemplate(command.actionItem.iconDescription, childContext)
            }
            if (Object.keys(changedActionItem).length !== 0) {
                changed.actionItem = { ...command.actionItem, ...changedActionItem }
            }
        }
        const modified = Object.keys(changed).length !== 0
        evaluatedCommands.push(modified ? { ...command, ...changed } : command)
    }
    return { ...contributions, commands: evaluatedCommands }
}
