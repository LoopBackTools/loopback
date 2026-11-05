# The project a hook's session works in: the name of the folder its repository is checked out in, or
# of the working directory outside one. A worktree names its main checkout, so a session in a
# worktree asks under the same project as one in the checkout itself. Every ask names its project
# this way, so one project never appears in the inbox under two names. Reads the hook's JSON input
# from $1.
project_of() {
	local cwd common
	cwd=$(jq -r '.cwd // empty' <<<"$1")
	cwd=${cwd:-$PWD}
	# Every checkout of a repository shares its .git directory, in the main checkout. A submodule's,
	# or one kept apart with --separate-git-dir, is elsewhere: those name the folder they are in.
	common=$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
	if [ "$(basename "$common")" = .git ]; then
		basename "$(dirname "$common")"
	else
		basename "$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$cwd")"
	fi
}
