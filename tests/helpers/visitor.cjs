require('./test-isolation.cjs');
const { app, demoStore } = require('../../app');
const realFetch = global.fetch;

async function start() {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  function visitor() {
    let cookie = '';
    return {
      async request(url, body, headers = {}) {
        const response = await realFetch(base + url, { method: body === undefined ? 'GET' : 'POST',
          redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers },
          body: body === undefined ? undefined : JSON.stringify(body) });
        const next = response.headers.get('set-cookie');
        if (next) cookie = next.split(';')[0];
        return { status: response.status, location: response.headers.get('location'), html: await response.text() };
      },
      async state() {
        const id = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
        return new Promise((resolve, reject) => demoStore.get(id, (error, state) => error ? reject(error) : resolve(state)));
      },
      async change(mutate) {
        const id = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
        const state = await this.state(); mutate(state.demo);
        await new Promise((resolve, reject) => demoStore.set(id, state, error => error ? reject(error) : resolve()));
      }
    };
  }
  return { visitor, close: () => new Promise(resolve => server.close(resolve)) };
}
module.exports = { start };
