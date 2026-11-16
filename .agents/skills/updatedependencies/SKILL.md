---
name: updatedependencies
description: >
  Update all dependencies in the project.
---

- Update ts dependencies in @client.
- Check if forks in @third_party:
    - If fixes are included upstream, replace fork with upstream version
    - Else update the fork to the latest upstream and backport the fix.
- Update all rust dependencies.
- Update runtimes in github actions
- Check with just ci for regressions

