# Ninja Tournament Scoreboard

Live scoring for ninja competitions. Runs in Safari/Chrome on iPads and phones — no app store install.

- **Winners** — top 20 for the selected division, updated live on every device. Most points wins; tied points are broken by fastest total time. Switch between Overall and each single course.
- **Judge** — pick a course, type points and time for each athlete, tap Return to save.
- **Athletes** — add one at a time or paste a list (`bib, name` per line), move between divisions.
- **Setup** — event name, courses (rename / reorder / add / delete), divisions (Make live → Mark final → next division).

Anyone with the URL can watch the Winners board. Only signed-in judges can record scores or change setup.

Stack: Vite (static site) · Supabase (Postgres, Realtime, Auth) · Vercel (hosting) · GitHub (source).

---

## 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query** → paste all of `supabase/schema.sql` → **Run**. This creates the tables, security rules, realtime, and starter data (Division A, Division B, Course 1–3).
3. **Authentication → Sign In / Providers → Email**: turn **off** "Allow new users to sign up" so only people you add can judge.
4. **Authentication → Users → Add user → Create new user**: create a login for each judge (or one shared judge login). Tick "Auto Confirm User".
5. **Project Settings → API**: copy the **Project URL** and the **anon public** key.

## 2. Run it locally (optional)

```bash
cp .env.example .env.local   # paste your URL and anon key
npm install
npm run dev
```

## 3. GitHub

```bash
git init
git add .
git commit -m "Ninja scoreboard"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/ninja-scoreboard.git
git push -u origin main
```

## 4. Vercel

1. **Add New → Project** → import the GitHub repo. Vercel detects Vite automatically.
2. Under **Environment Variables** add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. **Deploy.** Every push to `main` redeploys.

## On event day

1. Open the Vercel URL on every iPad/phone. On iPad: Share → **Add to Home Screen** for a full-screen app.
2. Judges tap **Judge sign in** once per device (the login is remembered).
3. In **Setup**, tap **Make live** on Division A. All screens follow the live division.
4. When Division A finishes, tap **Mark final** — its board becomes the awards results. Then **Make live** on Division B; it runs the same courses with its own leaderboard.
5. Any screen can tap a division chip to look at another division's results without affecting other devices.

## Scoring rules (in `standings()` in `src/main.js`)

- Overall: sum of points across all courses; ties broken by the lower sum of recorded times.
- Single course view: that course's points, ties broken by that course's time.
- Athletes with exactly the same points and time share a place.
- Times are typed as `1:23.45` or `83.45` (seconds).

## Starting a new tournament

In Supabase SQL Editor: `truncate runs, athletes cascade;` then rename divisions/courses in Setup.
