# FH-026 placeholder mark

`brand.json` owns the placeholder `mark`. The shared `markIconUrl()` in
`packages/forkhorse-dashboard/src/mark.ts` draws that value as escaped SVG text in
the viewer's emoji font. It also derives the SVG's accessible name from the brand.
No platform emoji artwork or new image binary is distributed.

| Surface | Wiring |
| --- | --- |
| OS sidebar account | Account `avatar` uses `markIconUrl(brand.mark)` |
| OS sidebar app entry | `providesUi.icon` uses the Phosphor Horse regular SVG selected by `brand.json.railIcon` |
| Admin and connection picker vendor | Vendor `logo` |
| Agent fork resource | Supported resource `icon` |
| Standalone dashboard, including its local fixture | Vite injects a favicon in the HTML head |
| Gatekeeper sidebar, configurator and picker frames | Build injects the same favicon |
| Core OAuth consent page | Core adds the favicon only to successful GET consent HTML |

The rail icon is separate from the emoji mark. `brand.json.railIcon` selects
`phosphor:horse`; the gatekeeper inlines the single regular-weight path from
`@phosphor-icons/react` 2.1.10, with a 256-square viewBox and `currentColor` fill.
The pinned OS (`8cbfb2b`) maps `description.providesUi.icon` to the app's icon in
`workshop-backend/src/server.ts`, then renders it as a 14px CSS mask filled with
the row's current text color in `workshop-frontend/src/components/AppShell/Sidebar.tsx`.
The account avatar is separate. Light, dark, hover and active colors come from
the OS row; the SVG has no fixed color. Phosphor's MIT notice is in `NOTICE`.

The OS stores the account description at connection time. After deployment, the
owner must reconnect once to refresh the cached app icon; changing this metadata
alone does not establish live visibility. All other surfaces retain the emoji.

The pinned OS consumes the image URLs through its existing identity components;
the adjacent product/resource labels remain their accessible names. The emoji SVG also
has an image role and the product name for use by a standalone viewer. No mark is
added to project titles, status markers, tabs or buttons.

The OAuth HTML transform preserves the response status, cookies and headers.
Authorization, enrollment, redirects and other OAuth responses are unchanged.
The dashboard's existing CSP permits data images. The helper encodes apostrophes
in addition to URI encoding, so its URL is safe in either HTML quote style.

## Validation and review boundary

The dashboard test parses the SVG as XML and checks injection-shaped future mark
values remain text, with no script, image or path elements. Native workerd tests
assert the actual vendor, resource and sidebar metadata, the served dashboard
favicon and the Access-authorized consent favicon while completing PKCE. The
gatekeeper build verifier checks all three generated frame favicons.

Final acceptance requires a fresh `--no-local` clone of the exact branch head,
frozen installs at root and upstream, touched package tests and typechecks,
`pnpm test`, `pnpm lint`, and isolated `pnpm check` with eight Worker dry-runs.
D5 uses exclusively created, mode-0600, ignored synthetic configuration, an empty
environment and HOME, loopback-only networking, and denied Keychain access.
It refuses an existing owner configuration and removes only its own file.

Browser captures must be labeled local fixtures. They establish local rendering,
not deployment or live acceptance. Design capture review and independent
code/safety review remain separate required gates; implementation checks alone
do not satisfy either review.
