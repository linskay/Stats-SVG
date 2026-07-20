# <i class="fa-brands fa-github fa-spin"></i>Stats SVG<i class="fa-solid fa-chart-line fa-fade"></i>

_A highly customizable stats SVG generator_

This project generates a visually appealing, highly customizable SVG image displaying GitHub user statistics. It's designed to be embedded in GitHub profiles or other web pages to showcase a user's GitHub activity and contributions.

> [!WARNING]
> This project is still under development so it may contain bugs and other issues. I'm actively testing it and fixing bugs as I find them. Feel free to sync with the latest code if you want to stay updated. Also, Any bugs/issues report is appreciated :)

## Features

- Fetches real-time GitHub user data using the GitHub GraphQL API
- Generates a customizable SVG image with user stats, displaying various metrics including commits, language usage, and many more
- Supports custom color schemes, configurations, and animated elements
- For ranking and language usage calculation, this repo uses the same algorithm as arguably the most famous README card repo on GitHub, [anuraghazra/github-readme-stats](https://github.com/anuraghazra/github-readme-stats), to maintain consistency with the same standard.

## Requirements and local checks

Use **Node.js 24 or newer** (the supported range is also enforced by the `engines` field in `package.json`). Install dependencies and run the project checks with:

```bash
npm install
npm test
npm run lint
npm run format:check
```

Use `npm run format` to apply formatting changes.

The repository automation, Conventional Commit format, release process, GitHub
branch-protection settings, and Vercel setup are documented in
[`docs/automation.md`](docs/automation.md).

## Deployment

Since the GitHub API only allows 5k requests per hour, the api provided by this repo could possibly hit the rate limiter. You can host your own instance of this repo on Vercel to avoid the rate limiter.

> [!IMPORTANT]
> The GitHub endpoint requires a GitHub Personal Access Token (PAT). A public deployment must **not** use a token that can access private data. Use a dedicated, least-privileged token that exposes only the public data required by the service.

<details>
 <summary><b>Manual Deployment</b></summary>

#### 1. Fork and Prepare the Repository

1. Fork this repository to your GitHub account
2. [Create a Personal Access Token (PAT)](https://github.com/settings/tokens/new)
   - Set the token name (e.g., "stats-svg")
   - Select only the minimum scopes needed for public GitHub data; do **not** grant the `repo` scope to a publicly deployed instance
   - Copy the generated token (you won't see it again so save it!)

#### 2. Deploy to Vercel

1. Visit [Vercel](https://vercel.com/)
2. Sign up/Log in with your GitHub account
3. From your Vercel dashboard:
   - Click `Add New...` → `Project`
   - Select the forked repository
   - Click `Import`

#### 3. Configure Environment Variables

1. In the project configuration screen:
   - Expand the `Environment Variables` section
   - Add a new variable:
     - Name: `GITHUB_TOKEN`
     - Value: Your GitHub PAT from step 1
2. Click `Deploy`

#### 4. Using Your Instance

- Once deployed, Vercel will provide you with a domain (e.g., `your-project.vercel.app`)
- Use any of the endpoints listed in the [API endpoints](#api-endpoints) section, replacing the example domain with your deployment domain.

#### Troubleshooting

- For issues, check Vercel's deployment logs or open an issue in this repository

</details>

## API endpoints

All endpoints accept a required `username` query parameter. Replace
`your-project.vercel.app` with the domain of your Vercel deployment.

| Endpoint               | Response                                                           | Required configuration |
| ---------------------- | ------------------------------------------------------------------ | ---------------------- |
| `/api/github-status`   | GitHub statistics as an SVG image.                                 | `GITHUB_TOKEN`         |
| `/api/leetcode-status` | LeetCode profile, skill, language, and contest statistics as JSON. | None                   |
| `/api/steam-status`    | Steam profile and game-play statistics as JSON.                    | `STEAM_API_KEY`        |

### GitHub statistics

```text
GET https://your-project.vercel.app/api/github-status?username=octocat
```

Returns an `image/svg+xml` response that can be embedded directly in a README:

```md
![GitHub Stats](https://your-project.vercel.app/api/github-status?username=octocat)
```

### LeetCode statistics

```text
GET https://your-project.vercel.app/api/leetcode-status?username=leetcode
```

Returns JSON containing the account username, solved-problem skill groups, language statistics, and contest data.

### Steam status

```text
GET https://your-project.vercel.app/api/steam-status?username=76561198000000000
```

For Steam, `username` must be the user's numeric SteamID. Set `STEAM_API_KEY` in your Vercel project environment variables before making this request. The response is JSON with profile, status, owned-game, and playtime data.

## Customization

[`config.js`](config.js) is the shared presentation configuration for the GitHub SVG card. Use it to set the SVG width and height, colors for text, icons, and rank elements, the rank and language ring geometry, and the contribution chart's visible-day count, colors, and animation timings. If you want to modify the SVG markup itself, edit [`src/render/render_github.js`](src/render/render_github.js).

## API

The local server exposes the following endpoints. Each endpoint requires the `username` query parameter. For Steam, `username` must be the numeric Steam ID used by the Steam Web API.

| Endpoint                                       | Required parameter | Response                                                                                                                                                    |
| ---------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/github-status?username=GITHUB_LOGIN`     | GitHub login       | An `image/svg+xml` GitHub statistics card. It is rendered from GitHub profile, contribution, repository, language, and rank data.                           |
| `/api/leetcode-status?username=LEETCODE_LOGIN` | LeetCode username  | A JSON object containing the username, solved-problem skill groups, languages, and contest statistics. It does not render an SVG.                           |
| `/api/steam-status?username=STEAM_ID`          | Numeric Steam ID   | A JSON object containing the Steam profile, status, recent and owned games, level, and playtime totals and platform percentages. It does not render an SVG. |

All three data fetchers keep successful results in an in-memory cache for two minutes. Requests without a valid `username` value, unknown routes, or upstream API failures are not successful responses.

### Rate limits

The local Express server applies separate per-IP fixed-window limits: GitHub has 60 requests per minute, LeetCode has 30, and Steam has 20. Exceeded requests return `429 Too Many Requests` with `Retry-After` and do not call the upstream provider.

On Vercel production deployments the same endpoint-specific limits are counted atomically in Vercel KV or Upstash Redis, so they are shared by all serverless instances. Configure `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or the compatible `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`) before deploying; production deliberately does not fall back to an in-memory limiter.

### Environment variables

| Variable        | Required for         | Purpose                                                                                                                                                                                        |
| --------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`  | `/api/github-status` | Authenticates requests to the GitHub GraphQL API. For a public deployment, it must be a dedicated least-privileged token with no access to private repositories or other private account data. |
| `STEAM_API_KEY` | `/api/steam-status`  | Authenticates requests to the Steam Web API.                                                                                                                                                   |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel production | Vercel KV or Upstash Redis REST credentials for distributed rate limiting. |

`/api/leetcode-status` does not require an environment variable: it queries LeetCode's public GraphQL endpoint. Set the variables in the deployment platform's environment-variable settings (or in a local `.env` file); never commit their values to the repository.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request and open an issue.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

Enjoy showcasing your GitHub stats in cyberpunk style! 🚀

#Cyberpunk2077 #Cyberpunk:Edgerunners

![GitHub Stats SVG](https://stats-svg.vercel.app/api/github-status?username=gh0stintheshe11)
