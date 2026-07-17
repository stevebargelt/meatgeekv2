---
id: MG-11
type: story
status: active
title: data-pusher-module-path-rename
---

#### Context
`apps/data-pusher`'s Go module path is currently `meatgeek-pusher` (declared in `go.mod`). #4 set the monorepo convention as `github.com/stevebargelt/meatgeekv2/apps/<app>`. Rename data-pusher to match.

#### Acceptance Criteria
- [ ] `apps/data-pusher/go.mod` module path → `github.com/stevebargelt/meatgeekv2/apps/data-pusher`
- [ ] All internal import paths updated
- [ ] `go build ./...`, `go vet ./...`, `go test ./...` all pass
- [ ] `nx build data-pusher` and `nx build-arm data-pusher` both pass

#### Notes
Now that #5 has landed, this is safe to run anytime.