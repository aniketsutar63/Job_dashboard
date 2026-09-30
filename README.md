# Aniket Sutar — Java Job Search Dashboard

Vercel-ready static dashboard.

## Deploy to Vercel
1. Upload this folder to a GitHub repository.
2. In Vercel, import the repository.
3. Framework Preset: Other.
4. Build Command: leave empty.
5. Output Directory: `.`
6. Deploy.

The dashboard entry point is `index.html`.

## Daily updates
The existing daily job-search automation can discover and score jobs, but a static Vercel deployment does not automatically rewrite itself. To make the site truly self-updating, the daily workflow needs a writable data/deployment connection (for example a GitHub repository + Vercel deployment workflow, or a database/API). The `data/jobs.json` file is included as the intended data layer.
