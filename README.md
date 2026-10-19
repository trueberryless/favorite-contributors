# Favorite contributors

[![Built with Astro](https://astro.badg.es/v2/built-with-astro/tiny.svg)](https://astro.build)
[![Netlify Status](https://api.netlify.com/api/v1/badges/25c8109c-8671-4e7b-958e-cdabfdc65170/deploy-status)](https://app.netlify.com/projects/favorite-contributors/deploys)

This is a little fun Astro project I built because I really like to play around with GitHub data in some ways -- especially if it involves GitHub Actions.

It's setup in a way where a selection of GitHub organisations is defined and all the contributions from popular repositories from these organisations will be backfilled and updated automatically. To add a new organisation, just create a new JSON file under [`/data`](./data) with the name of the org (in this example `withastro.json`) and this content:

```json
{
  "id": "withastro",
  "updatedAt": null
}
```

## Data and privacy

All data is collected from public repositories through the GitHub API: merged pull requests, reviews, linked issues and reactions. Only accounts that earned at least one point are listed.

### Opt out

If you don't want your GitHub account to appear in this project, [open an opt-out request](https://github.com/trueberryless/favorite-contributors/issues/new?template=opt-out.yml). Requests can only be made for the account that opens the issue.

A workflow then adds a SHA-256 hash of your lowercased username to [`data/excluded-users.json`](./data/excluded-users.json), so your username itself is never listed. The next data sync removes your profile and stats, anonymizes your activity in the cached raw data, and keeps your account out of all future syncs. Other contributors keep the review credit they earned on your pull requests.

### History

The git history of `main` and `release` is squashed into a single commit once a week, so removed data does not stay around in old commits. If you have a local clone, update it with `git fetch && git reset --hard origin/main` instead of `git pull`.

Made with ❤️ by Felix  
[License MIT](./LICENSE)
