// supabase.js — Supabase 클라이언트

const SUPABASE = {

  // ── Supabase API 키 관리 (localStorage) ──
  getKey() {
    return localStorage.getItem('supabaseKey') || '';
  },

  setKey(key) {
    localStorage.setItem('supabaseKey', key);
  },

  // ── 핵심 통신 함수 ──
  async query(method, table, body = null, params = '') {
    const key = this.getKey();
    if (!key) throw new Error('Supabase 키가 설정되지 않았습니다.');

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
      const err = await res.json();
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
