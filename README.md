# Flowlane

Kanban project management for a team. Data lives in **Supabase** (project "wave15 test"): every board, column, task, checklist item, comment and attachment is a database row, changes appear live in everyone's browser, and the database keeps an activity log of who did what.

## Run

Requires Node.js 20.11 or newer. No `npm install` needed.

```bash
npm start
```

Open http://localhost:3000. `server.js` only serves the files in `public/`; any static host works.

## Accounts and team

- Only invited emails can create an account. The first invite is the workspace owner (set in `supabase/migrations/…_auth_team_rls.sql`).
- The owner invites, revokes and removes people from **Account & team → Team & invites** (bottom of the sidebar).
- Everyone can change their display name there.

**Email confirmation:** Supabase's built-in mailer only delivers to members of your Supabase organisation and is rate-limited. For a real team, either set up custom SMTP (Supabase dashboard → Authentication → Emails) or turn off "Confirm email" (Authentication → Sign In / Providers → Email). When deploying somewhere other than localhost, set the Site URL under Authentication → URL Configuration.

## Layout

| Path | What it is |
| --- | --- |
| `public/index.html`, `styles.css`, `app.js` | The app |
| `public/config.js` | Supabase URL and publishable key (public by design) |
| `public/sw.js`, `manifest.webmanifest`, `icon.svg` | Installable app + offline shell |
| `supabase/migrations/` | Database schema, applied to the project in order |
| `server.js` | Static file server |

## Database

| Table | Holds |
| --- | --- |
| `profiles` | One per account: name, email, avatar colour |
| `workspaces`, `workspace_members`, `workspace_invites` | The team, its members (owner/member) and pending invites |
| `boards`, `board_columns`, `tasks` | Board structure and tasks (priority, assignee, due date, labels, position, archived) |
| `checklist_items`, `comments`, `attachments` | Task details |
| `activity` | Written only by database triggers: task created/edited/moved/archived/deleted, comments, checklist completions, column and board changes |

Row-level security limits every table to signed-in members of the workspace; signed-out visitors can read nothing. Comments can only be edited or deleted by their author; nobody can write to `activity` directly.

## How syncing works

The app keeps boards in memory as before. On each change it compares the current rows with the last copy the server confirmed and writes only the rows that changed (parents first), then deletes removed rows. Realtime events from other people are merged row by row; a row you are editing and haven't saved yet keeps your version. Offline, changes are kept in the browser and pushed when the connection returns.

## Not included yet

- Real file uploads (attachments are still name and size only; `attachments.storage_path` is reserved for Supabase Storage).
- Password reset.
