// supabase.js — Supabase 클라이언트

const SUPABASE = {

  // ── API 키를 sessionStorage에서 읽기 ──
  getKey() {
    return sessionStorage.getItem('supabaseKey') || '';
  },

  setKey(key) {
    sessionStorage.setItem('supabaseKey', key);
  },

  // ── 앱 최초 로딩 시 settings 테이블에서 key 가져오기 ──
  async loadKey() {
    const existing = this.getKey();
    if (existing) return existing;

    const key = CONFIG.SUPABASE_ANON_KEY;
    if (!key) throw new Error('앱 초기화 실패. 관리자에게 문의하세요.');

    this.setKey(key);
    return key;
  },

  // ── 핵심 통신 함수 ──
  async query(method, table, body = null, params = '') {
    const key = this.getKey();
    if (!key) throw new Error('세션이 만료되었습니다. 새로고침 후 다시 시도해주세요.');

    const url = `${CONFIG.SUPABASE_URL}/rest/v1/${table}${params}`;

    const res = await fetch(url, {
      method,
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=representation' : ''
      },
      body: body ? JSON.stringify(body) : null
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Supabase 오류: ${res.status}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : [];
  },

  // ── CRUD 헬퍼 ──
  select: (table, params = '') =>
    SUPABASE.query('GET', table, null, params),

  insert: (table, data) =>
    SUPABASE.query('POST', table, data),

  update: (table, data, params) =>
    SUPABASE.query('PATCH', table, data, params),

  delete: (table, params) =>
    SUPABASE.query('DELETE', table, null, params),

  upsert: (table, data) =>
    SUPABASE.query('POST', table, data)
};
