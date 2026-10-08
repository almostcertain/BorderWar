// Optional player accounts (docs/accounts-auth.md §6): a thin client for the
// server's /api/ routes. Client-only, nothing here touches the sim. The session
// lives in an HttpOnly cookie, so this file never sees or stores a token.
//
// `available` stays false when the page isn't served by the Node server (the
// static dev server, or a server running without accounts); the menu then
// hides its sign-in UI and everything plays as a guest.
const Account = {
  available: false,
  user: null,   // {id, email, displayName, tag, settings} when signed in

  // Resolves once it is known whether there is an account server and who, if
  // anyone, is signed in. Never rejects.
  init() {
    return fetch('api/me', { credentials: 'same-origin', cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        if (!data || !('user' in data)) return;
        this.available = true;
        this.user = data.user;
      })
      .catch(() => { /* no account server */ });
  },

  // POSTs JSON and resolves to the reply body. Rejects with an Error whose
  // message is fit to show the player and whose `code` is the server's error code.
  _post(route, body) {
    return fetch('api/' + route, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(
      r => r.json().catch(() => null).then(data => {
        if (r.ok && data) return data;
        const err = new Error((data && data.message) || 'Something went wrong. Try again.');
        err.code = (data && data.error) || 'server';
        throw err;
      }),
      () => { throw new Error('Can\'t reach the server. Check your connection.'); }
    );
  },

  _signedIn(data) { this.user = data.user; return data.user; },

  login(email, password) {
    return this._post('login', { email, password }).then(d => this._signedIn(d));
  },

  register(email, password, displayName, tag) {
    const body = { email, password };
    if (displayName) body.displayName = displayName;
    if (tag) body.tag = tag;
    return this._post('register', body).then(d => this._signedIn(d));
  },

  logout() {
    return this._post('logout').then(d => this._signedIn(d));
  },

  // fields: any of {displayName, tag, settings}.
  saveProfile(fields) {
    return this._post('profile', fields).then(d => this._signedIn(d));
  },

  // These three ask for the current password again.
  changeEmail(email, password) {
    return this._post('email', { email, password }).then(d => this._signedIn(d));
  },

  changePassword(current, next) {
    return this._post('password', { current, next }).then(d => this._signedIn(d));
  },

  deleteAccount(password) {
    return this._post('delete-account', { password }).then(d => this._signedIn(d));
  },

  // Achievements and cosmetics (docs/metaprogression.md §6.4). Both resolve to
  // the account's {unlocked, counters, equipped} and reject like _post.
  getProgress() {
    return fetch('api/progress', { credentials: 'same-origin', cache: 'no-store' }).then(
      r => r.json().catch(() => null).then(data => {
        if (r.ok && data) return data;
        const err = new Error((data && data.message) || 'Something went wrong. Try again.');
        err.code = (data && data.error) || 'server';
        throw err;
      }),
      () => { throw new Error('Can\'t reach the server. Check your connection.'); }
    );
  },

  // progress: any of {unlocked, counters, equipped}; the server merges it in.
  saveProgress(progress) {
    return this._post('progress', progress);
  }
};
