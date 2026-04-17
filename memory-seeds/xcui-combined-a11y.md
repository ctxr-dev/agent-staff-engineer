---
name: XCUITest combined accessibility elements
description: Containers built with accessibilityElement(children: .combine) do not reliably surface as otherElements. Assert on visible text instead.
type: feedback
portable: true
tags:
  language: swift
  testing: xcuitest
placeholders: []
---

In XCUITest on this project, a SwiftUI or UIKit container that groups its children via `.accessibilityElement(children: .combine)` merges its subtree into a single accessibility element. That merged element often fails to surface under the obvious query paths (`otherElements`, `buttons`, etc.) when you try to reach it by identifier alone.

**Why:** the combined element inherits a composite label, but the accessibility tree still records the original hierarchy. XCUITest query resolution sometimes finds the inner pieces, sometimes the outer combined element, depending on the runtime tree. Identifier-based queries are the first to fail.

**How to apply:**

- Prefer asserting on visible text (labels the combined element exposes) over asserting on `accessibilityIdentifier`.
- If an identifier is necessary, set it on a child that is itself a focusable, individually addressable element, not on the combined container.
- When a query returns zero matches, fall back to `app.staticTexts["..."]` or `app.descendants(matching: .any).matching(identifier:"...")` rather than assuming the container is gone.
- When a query returns the wrong element, add a more specific accessibility identifier on a concrete child and query for that.

Keep XCUITest fixtures minimal; inject test data at the SwiftData layer rather than trying to drive every element through the accessibility tree.
