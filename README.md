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

Made with ❤️ by Felix  
[License MIT](./LICENSE)
