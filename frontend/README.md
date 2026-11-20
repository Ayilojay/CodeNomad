# CodeNomad Frontend

User-facing market navigation and operational surfaces for CodeNomad.

## Accessibility

Market navigation is built to be usable with a keyboard and screen reader:

- **Market selection** — the market list is a labeled listbox (`role="listbox"` with `aria-label`); each market is a focusable option (`role="option"`, `aria-selected`) operable with `Enter`/`Space` and arrow keys. The active market is announced via `aria-activedescendant`.
- **Status indicators** — market status (e.g. live, stale, error) is exposed with `role="status"` and `aria-live="polite"` so state changes are announced without stealing focus. Status is never rendered as "live" unless it comes from verified chain/indexer state.
- **Controls** — all interactive controls are native buttons/links or have an explicit `role` plus keyboard handlers; every control has an accessible name (`aria-label` or visible text).
- **Notifications** — toasts/notifications use `role="alert"` (errors) or `role="status"` (informational) with `aria-live`, and are dismissible via keyboard.
- **Focus visibility** — focus rings are never removed; `:focus-visible` styles are defined for all interactive elements.
- **Contrast** — text and status colors meet WCAG AA contrast against their backgrounds.

### Responsive layout

- **Mobile (< 640px)** — market navigation collapses into a single-column, scrollable list; the selected market and its status are shown above the controls. Controls stack vertically and meet the 44px minimum touch target.
- **Tablet / desktop (>= 640px)** — market list and detail panel sit side by side.

## Failure behavior

- Sample or fixture data is never displayed as live market data.
- Signature and chain verification are never bypassed in the UI; unverified state is shown as such.
- Errors surface explicitly (error status + alert notification); the UI does not silently fall back to stale or placeholder data after a failure.

## Testing

Focused tests cover keyboard operation of market selection, screen-reader labels, responsive layout classes, and failure states (verification failure, fetch error, empty market list). Run the frontend package tests and build in CI:

```sh
npm test
npm run build
```

### Manual verification

Before testnet use, verify against localnet or deterministic fixtures:

1. Tab through market selection, status, controls, and notifications — every element is reachable and operable, with a visible focus ring.
2. Confirm screen-reader announcements for market selection changes and status/notification updates.
3. Resize to mobile width and confirm the single-column layout and touch targets.
4. Force a verification/fetch failure and confirm an explicit error is shown (no silent fallback, no sample data presented as live).
