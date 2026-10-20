# Revised implementation plan — Nishant Tiwari portfolio

## User-requested change

Move the gallery beyond the earlier per-browser IndexedDB model. Use project Storage for uploaded file bytes and the managed MySQL database for shared media metadata, captions, ordering and the optional hero replacement. Keep the site visitor-facing, but make editing available only through a server-verified owner key. Replace the overflow/scroll gallery with a genuine left-to-right transform track so an owner can add many media items and navigate every one without a scrollbar.

## Architecture and data flow

- Keep `index.html` as the self-contained front end (inline HTML/CSS/vanilla JavaScript). Its public gallery and hero image load from same-origin JSON endpoints. Public visitors can view media; editor writes are authenticated.
- Add `server.js` as the Node HTTP server for the static page, `/health`, and `/api` endpoints. It reads managed `DATABASE_URL`, `MANUS_API_URL`, and `MANUS_API_KEY` at runtime. No private value is embedded in HTML or Docker build output.
- Add an additive, versioned SQL migration for a gallery-media index and a small site-setting record. Store only media metadata and stable asset keys in SQL; send the image/video bytes to Manus project object storage via the runtime presigned PUT contract, then reference the stable `/manus-storage/<key>` address. Runtime object deletion is not available, so removal hides a record (soft delete) and the interface will say so.
- Protect owner verification, upload, display-name/caption updates, reordering, hero changes, and hide/remove operations with the server-held owner key collected through the protected input card and compared only by the server. The browser holds the entered key in memory while its editor is open; never store the key in local storage or publish it in client code.
- The gallery picker explicitly lists JPG/JPEG, PNG, WebP, GIF, BMP, AVIF and MP4/M4V, WebM, MOV. Convert still images in-browser to WebP (JPEG fallback where WebP encoding is unavailable) before upload, using extension fallback for valid files whose MIME type is blank or generic. HEIC/HEIF and unsupported video containers receive a helpful format-specific message rather than appearing accepted. Keep videos in original format; normalize M4V and generic MIME values from recognized video extensions on the server. Limit optimized images to 15 MB and videos to 80 MB. Owners can edit each item’s display name (max 255 characters) and caption (max 180 characters), reorder, and hide it. When a video slide becomes active, start loading it immediately and autoplay it muted unless `prefers-reduced-motion` is enabled; pause other video elements and defer their loading until selected. Keep controls so visitors may unmute, subject to browser autoplay policy.
- The carousel is a clipped viewport plus a transform-driven track: one frame per position, previous/next buttons, keyboard arrows, pointer/touch swipe, a position counter and motion-safe transitions. Newly saved media joins the track and is shown with a smooth horizontal transition. No horizontal overflow or native scrollbar is the navigation model.
- Preserve the supplied, optimized WebP hero as the default; an owner replacement becomes a project-storage asset referenced from the site-settings row. Keep original supplied assets untouched.
- Enhance the existing editorial dark UI with restrained procedural light motes, a soft animated film-light sweep, clearer upload/edit states and accessible focus indicators. Suspend the canvas offscreen, honor `prefers-reduced-motion`, keep videos lazy and avoid adding a front-end animation library.

## Managed capabilities and runtime

The user explicitly authorized enabling the one-way Webdev server and managed database capabilities. Development and publication share that database, so migrations must be additive and safe. Store features as `{server:true,database:true}`. Use a pinned pnpm Node project and lockfile; include checked-in lifecycle-build policy. Add a root `Dockerfile` that installs production dependencies and runs the server. Declare `deploy.healthPath` as `/health`; the handler returns an unauthenticated success only after the schema is ready. Do not enable automatic publication. Checkpoint the implementation to the canonical `main` branch; do not publish without a separate request.

## Project structure

- `index.html` — single-file front-end, transform slider, public gallery, protected editor UI and browser-side image compression.
- `server.js` — same-origin static/JSON server, authentication check, upload transfer, gallery/hero APIs and health endpoint.
- `migrations/001_gallery_and_site_settings.sql` — additive media and site-setting schema.
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` — pinned Node dependencies and install-script policy.
- `Dockerfile` — production installation and server entrypoint.
- `manus-routes.json` — one-page route declaration.
- `nishant-portrait.webp` and `/manus-storage/...` asset path — optimized supplied hero image.
- `app.config.ts` — existing project logo metadata.
- `TODO.md` — full acceptance outcomes and completion status.

## Design direction

- **Movement:** cinematic editorial design shaped by film contact sheets and darkroom light.
- **Principles:** large confident type, restrained warm highlights, image-first framing, useful controls with accessible states.
- **Color and signature:** near-black canvas, warm off-white typography and a controlled vermilion accent for recording/editor markers.
- **Layout and motifs:** asymmetrical editorial sections, framed media, thin film-line dividers, small numbered markers.
- **Interaction and animation:** controls slide the filmstrip laterally; new uploads join the track. Motes drift slowly behind the hero, a light sweep crosses infrequently, and page reveals stay quiet. Motion stops offscreen and respects reduced-motion preferences.
- **Typography and voice:** condensed display headlines with a clean sans-serif body; copy is concise and cinematic, never inventing biographical or client claims.
- **Brand essence:** a practical cinematography and short-form video portfolio for prospective clients; visual, composed, direct.
