# Dataset Collector — setup guide

A small installable web app for collecting labeled images into two categories
(`small_object`, `occluded_image`), with on-device quality checks and a
reviewer queue, uploading straight into a shared Google Drive.

No backend server is required — it talks to Google Drive directly from the
browser. That means two things you need to do before it works:

## 1. Create a Google OAuth Client ID

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and create (or pick) a project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → set it up (Internal if you're on Google Workspace and only your team will use it; External + "Testing" mode works fine for a small group — add your collectors' emails as test users).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID** → type **Web application**.
5. Under **Authorized JavaScript origins**, add the URL you'll deploy this to (e.g. `https://yourname.github.io` or `https://your-app.netlify.app`). Add `http://localhost:5500` (or whatever) too if you want to test locally.
6. Copy the generated **Client ID**.

## 2. Configure the app

Open `app.js` and edit the top of the file:

```js
const CONFIG = {
  CLIENT_ID: 'YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com', // <- paste yours
  ROOT_FOLDER_NAME: 'ImageDataset',   // change if you want a different Drive folder name
  REVIEWER_PASSCODE: 'changeme',      // <- change this before sharing the link
  ...
};
```

The Drive folder structure (`ImageDataset/pending_review/small_object`, etc.)
is created automatically the first time someone signs in — you don't need to
make it by hand.

Note: everyone who signs in uploads into **their own Drive's** `ImageDataset`
folder (the app only ever requests the `drive.file` scope — access to files
it creates, nothing else in anyone's Drive). If you want everyone uploading
into **one shared team Drive account**, the simplest approach is: create the
folder structure in that one account, share it with your collectors as
Editors, and have them sign in with an account that has edit access to it —
Drive API calls will then write into the shared folder they see rather than
their own personal Drive. Say the word if you'd like me to adjust the code
to target a specific shared-drive folder ID instead of auto-creating a
personal one.

## 3. Deploy

Any static host works — this is plain HTML/CSS/JS, no build step. Easiest options:

- **GitHub Pages**: push this folder to a repo, enable Pages on the `main` branch.
- **Netlify / Vercel**: drag-and-drop the folder, or connect the repo.

Once deployed, open the URL on a phone and use "Add to Home Screen" to install it like an app.

## How the quality checks work

| Check | What it does | Tunable in CONFIG |
|---|---|---|
| Resolution | Rejects images smaller than a minimum width/height | `MIN_WIDTH`, `MIN_HEIGHT` |
| Sharpness | Estimates blur using a Laplacian-variance edge score on a downsized grayscale copy | `BLUR_VARIANCE_THRESHOLD` |
| Duplicate | Computes an 8×8 average hash of the image and compares it (Hamming distance) against hashes of everything previously uploaded **from that device** | hardcoded distance ≤ 4 in `isDuplicate()` |

None of these block an upload — they warn, and the person can choose
"Upload anyway." Everything still lands in `pending_review/<category>`
first, so a human makes the final call in Review mode regardless.

**Limitation to know about:** the duplicate check only compares against
images uploaded from the *same device* (it's stored in that browser's local
IndexedDB, not synced). If several people are collecting on different
phones, true cross-device duplicates won't be caught automatically — the
human review step is your backstop for that. If this matters a lot, the
fix is to store the hash index as a small JSON file in Drive that every
device reads/updates — happy to add that if you want it.

## Review mode

Anyone who knows the reviewer passcode can switch to "Review," see
thumbnails of everything sitting in `pending_review`, and Approve (moves to
`approved/<category>`) or Reject (moves to `rejected`). This is intentionally
a shared passcode rather than a per-user role system, to keep setup simple —
let me know if you want real per-person permissions instead.

## Things you may want to extend later

- Push the hash-dedup index into Drive so it works across devices/collectors
- Add EXIF/GPS capture if location matters for your dataset
- Swap the average-hash duplicate check for a stronger perceptual hash if you're seeing false negatives
- Add a lightweight on-device object-detection check (e.g. via TensorFlow.js) to flag images where nothing was detected at all, before they even hit the category buttons
