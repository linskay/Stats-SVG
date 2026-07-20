// Import necessary functions
import fetchGitHubData from '../src/fetch/fetch_github.js';
import fetchLeetCodeStats from '../src/fetch/fetch_leetcode.js';
import fetchSteamStatus from '../src/fetch/fetch_steam.js';
import renderStats from '../src/render/render_github.js';
import { createRequestDeadline, UpstreamRequestError } from '../src/fetch/http.js';

export default async function handler(req, res) {
  const { username } = req.query;
  const deadline = createRequestDeadline();

  try {
    if (req.url.includes('github-status')) {
      const stats = await fetchGitHubData(username, deadline);
      //console.log(stats);
      console.time('render stats');
      const svg = await renderStats(stats);
      console.timeEnd('render stats');
      deadline.throwIfExpired();
      res.setHeader('Content-Type', 'image/svg+xml');
      console.time('send svg');
      res.send(svg);
      console.timeEnd('send svg');

    } else if (req.url.includes('leetcode-status')) {
      console.time('fetch leetcode stats');
      const stats = await fetchLeetCodeStats(username, deadline);
      console.timeEnd('fetch leetcode stats');
      deadline.throwIfExpired();
      console.log(stats);
      res.status(200).json(stats);

    } else if (req.url.includes('steam-status')) {
      console.time('fetch steam status');
      const stats = await fetchSteamStatus(username, deadline);
      console.timeEnd('fetch steam status');
      deadline.throwIfExpired();
      console.log(stats);
      res.status(200).json(stats);
    } else {
      res.status(404).send('Not Found');
    }

  } catch (error) {
    console.error('Error in handler:', error);
    // Use error handling specific to your server framework
    // For example, in Express.js:
    if (error instanceof UpstreamRequestError) {
      res.status(error.status).send(error.status === 504 ? 'Request deadline exceeded. Please try again later.' : 'Upstream service temporarily unavailable. Please try again later.');
    } else if (error.response && error.response.status === 403) {
      res.status(503).send('Service temporarily unavailable due to GitHub API rate limits. Please try again later.');
    } else {
      res.status(500).send('Error fetching data or rendering image');
    }
  } finally {
    deadline.dispose();
  }
}
