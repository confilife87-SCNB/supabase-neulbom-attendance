const API = {

  // ── secretToken 관리 ──
  getSecretToken() {
    return localStorage.getItem('secretToken') || '';
  },

  setSecretToken(token) {
    localStorage.setItem('secretToken', token);
  },

  // ── sessionToken 관리 ──
  getSessionToken() {
    return sessionStorage.getItem('sessionToken') || '';
  },

  setSessionToken(token) {
    sessionStorage.setItem('sessionToken', token);
  },

  clearSession() {
    sessionStorage.removeItem('sessionToken');
    sessionStorage.removeItem('sessionRole');
  },

  // ── 핵심 통신 함수 ──
async call(action, params = {}, timeoutMs = 30000) {
    const secretToken = this.getSecretToken();
    const sessionToken = this.getSessionToken();

    const body = {
      action,
      params,
      secretToken,
      sessionToken
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(CONFIG.GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const json = await res.json();

      if (!json.success) {
        // 세션 만료 처리
        if (json.code === 401) {
          API.clearSession();
          throw new Error('세션이 만료되었습니다. 다시 로그인하세요.');
        }
        throw new Error(json.error || '서버 오류가 발생했습니다.');
      }

      return json.data;

    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('요청 시간 초과. 서류 생성은 수분이 소요됩니다.');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  },

  // ── 재시도 래퍼 (최대 2회) ──
  async callWithRetry(action, params = {}, maxRetry = 2) {
    for (let i = 0; i <= maxRetry; i++) {
      try {
        return await this.call(action, params);
      } catch (err) {
        if (i === maxRetry) throw err;
        showToast(`⚠️ 재시도 중... (${i + 1}/${maxRetry})`);
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  },

  // ── 인증 ──
  async verifyPassword(roleOrProgName, inputPwd) {
    const data = await this.call('verifyPassword', { roleOrProgName, inputPwd });
    if (data.isValid) {
      this.setSessionToken(data.sessionToken);
      sessionStorage.setItem('sessionRole', data.role);
    }
    return data;
  },

  updatePassword: (roleOrProgName, newPwd) =>
    API.call('updatePassword', { roleOrProgName, newPwd }),

  getPasswordList: () =>
    API.call('getPasswordList'),

  // ── 초기 로딩 ──
  getInitialData: () =>
    API.call('getInitialData'),

  // ── 강사 ──
  getInstDashboardData: (progName, targetDay, targetPeriod, selectedDate) =>
    API.call('getInstDashboardData', { progName, targetDay, targetPeriod, selectedDate }),

  saveAttendanceData: (selectedDate, progName, day, period, attendanceList, isCanceled, substituteInstructor) =>
    API.callWithRetry('saveAttendanceData', { selectedDate, progName, day, period, attendanceList, isCanceled, substituteInstructor }),

  saveActivityLog: (selectedDate, progName, day, periods, activityContent, substituteInstructor) =>
    API.callWithRetry('saveActivityLog', { selectedDate, progName, day, periods, activityContent, substituteInstructor }),

  getExistingAttendance: (selectedDate, progName, day, period) =>
    API.call('getExistingAttendance', { selectedDate, progName, day, period }),

  // ── 담임 ──
  getHomeroomStudents: (grade, classNum, targetDate) =>
    API.call('getHomeroomStudents', { grade, classNum, targetDate }),

  saveHomeroomMemos: (grade, classNum, memoData, targetDate) =>
    API.callWithRetry('saveHomeroomMemos', { grade, classNum, memoData, targetDate }),

  getHomeroomTodayStatus: (grade, classNum, targetDate) =>
    API.call('getHomeroomTodayStatus', { grade, classNum, targetDate }),

  getHomeroomAttendance: (grade, classNum, month) =>
    API.call('getHomeroomAttendance', { grade, classNum, month }),

  saveClassNotice: (grade, classNum, notice) =>
    API.call('saveClassNotice', { grade, classNum, notice }),

  getClassNotice: (grade, classNum) =>
    API.call('getClassNotice', { grade, classNum }),

  // ── 관리자 ──
  getAdminAllData: (targetDate, periodType) =>
    API.call('getAdminAllData', { targetDate, periodType }),

  getRecordsByPeriod: (targetDate, periodType) =>
    API.call('getRecordsByPeriod', { targetDate, periodType }),

  updateAdminRecord: (recordKey, newStatus, newReason) =>
    API.callWithRetry('updateAdminRecord', { recordKey, newStatus, newReason }),

  getSubmissionStatus: (targetDate, periodType) =>
    API.call('getSubmissionStatus', { targetDate, periodType }),

  generateAbsentMessages: (targetDate, periodType) =>
    API.call('generateAbsentMessages', { targetDate, periodType }),

  // ── 서류 ──
  getAttendanceDocList: () =>
    API.call('getAttendanceDocList'),

  generateAttendanceDoc: (month, targetProg) =>
    API.call('generateAttendanceDoc', { month, targetProg }, 600000),

  generateActivityDoc: (month, targetProg) =>
    API.call('generateActivityDoc', { month, targetProg }, 600000),

  finalizeMonth: (month, docType) =>
    API.call('finalizeMonth', { month, docType }, 600000),

  // ── 학생관리 ──
  getAdminStudentList: (grade, classNum, targetDate) =>
    API.call('getAdminStudentList', { grade, classNum, targetDate }),

  saveAdminDailyNotes: (grade, classNum, memoData) =>
    API.callWithRetry('saveAdminDailyNotes', { grade, classNum, memoData }),

  savePermNote: (grade, classNum, name, permNote) =>
    API.callWithRetry('savePermNote', { grade, classNum, name, permNote }),

  getActivityLogList: (month, progName) =>
    API.call('getActivityLogList', { month, progName }),

  updateActivityLog: (rowIndex, newContent) =>
    API.callWithRetry('updateActivityLog', { rowIndex, newContent }),

  // ── 강사 미입력현황 ──
  getInstMissingList: (progName, month) =>
    API.call('getInstMissingList', { progName, month })
};
