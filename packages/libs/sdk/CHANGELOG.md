# @cyrnel/sdk

## 1.2.0

### Minor Changes

- 5820828: Add `stale` to `ListServiceInput`, `ListServiceResult`, `GetServiceResult` and `effectivelyEnabled` to `GetToolResult`

  - `ListServiceInput.stale`: Environment modules can now filter by stale status when discovering services.
  - `ListServiceResult.stale` and `GetServiceResult.stale`: Service metadata includes the stale flag in list and get responses.
  - `GetToolResult.effectivelyEnabled`: Tool metadata includes the effective enabled state (tool enabled AND service enabled), matching `ListToolResult`.

### Patch Changes

- 5820828: Add `effectivelyEnabled` to `ListServiceResult`, `GetServiceResult`, and `ListToolResult`

## 1.1.2

### Patch Changes

- 8e57bb6: Exclude source maps from published package, add missing package metadata for npm publishing

## 1.1.1

### Patch Changes

- 0ac3645: remove source maps from build output; add repository field

## 1.1.0

### Minor Changes

- 752be8c: First public release.
