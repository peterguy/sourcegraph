package lockfiles

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"sort"
	"testing"

	"github.com/google/go-cmp/cmp"

	"github.com/sourcegraph/sourcegraph/internal/api"
	"github.com/sourcegraph/sourcegraph/internal/conf/reposource"
	"github.com/sourcegraph/sourcegraph/internal/gitserver"
)

func TestListDependencies(t *testing.T) {
	gitSvc := NewMockGitService()
	gitSvc.LsFilesFunc.SetDefaultReturn([]string{"client/package-lock.json", "package-lock.json"}, nil)
	gitSvc.ArchiveFunc.SetDefaultHook(func(c context.Context, repo api.RepoName, ao gitserver.ArchiveOptions) (io.ReadCloser, error) {
		var b bytes.Buffer
		zw := zip.NewWriter(&b)
		defer zw.Close()

		for file, data := range map[string]string{
			"client/package-lock.json": `{"dependencies": { "@octokit/request": {"version": "5.6.2"} }}`,
			"package-lock.json":        `{"dependencies": { "nan": {"version": "2.15.0"} }}`,
		} {
			w, err := zw.Create(file)
			if err != nil {
				t.Fatal(err)
			}

			_, err = w.Write([]byte(data))
			if err != nil {
				t.Fatal(err)
			}
		}

		return io.NopCloser(&b), nil
	})

	s := TestService(gitSvc)

	ctx := context.Background()
	got, err := s.ListDependencies(ctx, "foo", "HEAD")
	if err != nil {
		t.Fatal(err)
	}

	want := []reposource.PackageDependency{
		npmDependency(t, "@octokit/request@5.6.2"),
		npmDependency(t, "nan@2.15.0"),
	}

	sort.Slice(got, func(i, j int) bool {
		return got[i].PackageManagerSyntax() < got[j].PackageManagerSyntax()
	})

	comparer := cmp.Comparer(func(a, b reposource.PackageDependency) bool {
		return a.PackageManagerSyntax() == b.PackageManagerSyntax()
	})

	if diff := cmp.Diff(want, got, comparer); diff != "" {
		t.Fatalf("dependency mismatch (-want +got):\n%s", diff)
	}
}

func npmDependency(t testing.TB, dep string) *reposource.NPMDependency {
	t.Helper()

	d, err := reposource.ParseNPMDependency(dep)
	if err != nil {
		t.Fatal(err)
	}

	return d
}