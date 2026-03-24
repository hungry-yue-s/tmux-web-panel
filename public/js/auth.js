/**
 * Client-side auth token management.
 * Loaded before other scripts — provides the Auth global.
 */

/* eslint-disable no-unused-vars */
var Auth = {
  _TOKEN_KEY: 'tmux_auth_token',

  getToken: function () {
    try { return localStorage.getItem(this._TOKEN_KEY); } catch (_e) { return null; }
  },

  setToken: function (token) {
    try { localStorage.setItem(this._TOKEN_KEY, token); } catch (_e) {}
  },

  clearToken: function () {
    try { localStorage.removeItem(this._TOKEN_KEY); } catch (_e) {}
  },

  /** Returns headers object with Authorization if token exists. */
  headers: function () {
    var token = this.getToken();
    if (token) {
      return { 'Authorization': 'Bearer ' + token };
    }
    return {};
  },

  /** Returns query string fragment 'token=xxx' or empty string. */
  wsTokenParam: function () {
    var token = this.getToken();
    return token ? 'token=' + encodeURIComponent(token) : '';
  },

  /** POST logout, clear token, redirect to login page. */
  logout: function () {
    var token = this.getToken();
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    fetch('/api/auth/logout', { method: 'POST', headers: headers })
      .catch(function () {})
      .finally(function () {
        Auth.clearToken();
        window.location.href = '/login.html';
      });
  },
};
