---
name: DST-safe day counting (Swift)
description: When counting days in Swift on this project, normalise to startOfDay and use Calendar.date(byAdding:) rather than raw 86400 arithmetic.
type: feedback
portable: true
tags:
  language: swift
placeholders: []
---

When computing day differences or day-offsets in Swift on this project, always:

1. Normalise both dates to `calendar.startOfDay(for:)` first.
2. Use `calendar.dateComponents([.day], from:, to:)` to compute the difference.
3. Use `calendar.date(byAdding: .day, value:, to:)` to add days; never multiply by 86400.

**Why:** day counts and offsets computed with raw `TimeInterval` arithmetic (e.g. `date.addingTimeInterval(86400)`) produce wrong results on DST transition days. `Calendar` APIs account for daylight saving, leap seconds, and locale-specific day boundaries.

**How to apply:**

```swift
// Wrong
let tomorrow = date.addingTimeInterval(86_400)

// Right
var cal = Calendar(identifier: .gregorian)
cal.timeZone = .current
let start = cal.startOfDay(for: date)
let tomorrow = cal.date(byAdding: .day, value: 1, to: start)!

// Difference in days between two dates
let lhs = cal.startOfDay(for: a)
let rhs = cal.startOfDay(for: b)
let days = cal.dateComponents([.day], from: lhs, to: rhs).day ?? 0
```

When writing unit tests that depend on day boundaries, prefer explicit fixtures with timezone and DST configured rather than relying on the host machine's clock.
