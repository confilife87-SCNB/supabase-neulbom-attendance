// ==========================================
// api.js — 순창초 늘봄 플랫폼 V5.2
// 전면 수정: 버그수정 + 기능개선
// ==========================================

const API = {

  // ==========================================
  // 🔐 세션 관리
  // ==========================================

  // 강사명 캐시 (세션 동안 유지 — API 호출 최소화)
  _instructorCache: {},

  getSessionToken() {
    return sessionStorage.getItem('sessionToken') || '';
  },

  setSessionToken(token) {
    sessionStorage.setItem('sessionToken', token);
  },

  clearSession() {
    sessionStorage.removeItem('sessionToken');
    sessionStorage.removeItem('sessionRole');
    sessionStorage.removeItem('sessionProg');
    sessionStorage.removeItem('sessionExpiry');
    this._instructorCache = {};
  },

  isSessionValid() {
    const expiry = sessionStorage.getItem('sessionExpiry');
    if (!expiry) return false;
    return Date.now() < parseInt(expiry);
  },

  // ==========================================
  // 🔐 인증
  // ==========================================

  async verifyPassword(roleOrProgName, inputPwd) {
    const data = await SUPABASE.select('settings',
      `?role=eq.${encodeURIComponent(roleOrProgName)}&select=role,password`
    );
    if (!data || data.length === 0) return { isValid: false };

    const isValid = data[0].password === inputPwd;
    if (isValid) {
      const token = crypto.randomUUID();
      const role = roleOrProgName === '관리자' ? 'admin'
        : roleOrProgName.includes('담임') ? 'hr' : 'inst';
      this.setSessionToken(token);
      sessionStorage.setItem('sessionRole', role);
      sessionStorage.setItem('sessionProg', roleOrProgName);
      sessionStorage.setItem('sessionExpiry', Date.now() + 1800000);
    }
    return { isValid, role: isValid ? sessionStorage.getItem('sessionRole') : null };
  },

  async updatePassword(roleOrProgName, newPwd) {
    await SUPABASE.update('settings',
      { password: newPwd },
      `?role=eq.${encodeURIComponent(roleOrProgName)}`
    );
    return true;
  },

  async getPasswordList() {
    const data = await SUPABASE.select('settings',
      '?select=role,password&order=role&role=neq._appkey'
    );
    return data.map(d => ({ role: d.role, pwd: d.password }));
  },

  // ==========================================
  // 📅 운영 예외일 관리 (operation_exceptions)
  // ==========================================

  async getOperationExceptionList(startDate, endDate) {
    const start = startDate || '2026-01-01';
    const end   = endDate   || '2026-12-31';
    return await this._safeSelect(
      'operation_exceptions',
      `?start_date=lte.${end}&end_date=gte.${start}&order=start_date.asc,end_date.asc,type.asc`
    );
  },

  async addOperationException(startDate, endDate, type, reason) {
    const s = String(startDate || '').trim();
    const e = String(endDate   || startDate || '').trim();
    const t = String(type      || '기타').trim();
    const r = String(reason    || '').trim();

    if (!s || !e) throw new Error('시작일과 종료일을 입력해주세요.');
    if (e < s)    throw new Error('종료일은 시작일보다 빠를 수 없습니다.');

    const inserted = await SUPABASE.insert('operation_exceptions', [{
      start_date: s, end_date: e, type: t, reason: r
    }]);
    return Array.isArray(inserted) ? inserted[0] : true;
  },

  async deleteOperationException(id) {
    if (!id) throw new Error('삭제할 운영 제외일 id가 없습니다.');
    await SUPABASE.delete('operation_exceptions', `?id=eq.${id}`);
    return true;
  },

  // ==========================================
  // 🔄 초기 로딩
  // ==========================================

  async getInitialData() {
    // ⭐ operation_exceptions도 함께 로딩 (하드코딩 holidays 대체)
    const [students, exceptions] = await Promise.all([
      SUPABASE.select('students', '?select=grade,class_num,day,period,program'),
      this._safeSelect('operation_exceptions',
        '?select=start_date,end_date,type,reason&order=start_date.asc')
    ]);

    // 프로그램 구조 생성
    const programStructure = {};
    students.forEach(s => {
      if (!s.program || !s.day || !s.period) return;
      const day = this._normalizeDay(s.day);
      if (!programStructure[s.program]) programStructure[s.program] = {};
      if (!programStructure[s.program][day]) programStructure[s.program][day] = [];
      if (!programStructure[s.program][day].includes(s.period)) {
        programStructure[s.program][day].push(s.period);
      }
    });

    // 학급 구조 생성
    const homeroomStructure = {};
    students.forEach(s => {
      if (!s.grade || !s.class_num) return;
      if (!homeroomStructure[s.grade]) homeroomStructure[s.grade] = [];
      if (!homeroomStructure[s.grade].includes(s.class_num)) {
        homeroomStructure[s.grade].push(s.class_num);
      }
    });
    Object.keys(homeroomStructure).forEach(g => {
      homeroomStructure[g].sort((a, b) => a - b);
    });

    // ⭐ 예외일 날짜 배열 생성 (DB 기반 동적 공휴일)
    const operationExceptions = [];
    exceptions.forEach(ex => {
      const start = new Date(ex.start_date + 'T00:00:00');
      const end   = new Date(ex.end_date   + 'T00:00:00');
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        operationExceptions.push(d.toISOString().slice(0, 10));
      }
    });

    return { programStructure, homeroomStructure, operationExceptions };
  },

  // ==========================================
  // 🔵 강사
  // ==========================================

  async getInstDashboardData(progName, targetDay, targetPeriod, selectedDate) {
    // ⭐ B3 수정: day 정규화 통일
    const normalizedDay = this._normalizeDay(targetDay);

    // ⭐ 병렬 처리로 성능 개선
    const [students, existingArr, memos, contacts, actLogs] = await Promise.all([
      SUPABASE.select('students',
        `?program=eq.${encodeURIComponent(progName)}&day=eq.${encodeURIComponent(normalizedDay)}&period=eq.${encodeURIComponent(targetPeriod)}`
      ),
      SUPABASE.select('attendance',
        `?date=eq.${selectedDate}&program=eq.${encodeURIComponent(progName)}&period=eq.${encodeURIComponent(targetPeriod)}`
      ),
      SUPABASE.select('pre_memos', `?date=eq.${selectedDate}`),
      SUPABASE.select('contacts', '?select=grade,class_num,name,phone'),
      SUPABASE.select('activity_logs',
        `?date=eq.${selectedDate}&program=eq.${encodeURIComponent(progName)}&order=created_at.desc`
      )
    ]);

    // 기존 출결 맵
    const existing = {};
    existingArr.forEach(r => {
      existing[`${r.grade}_${r.class_num}_${r.name}`] = {
        status: r.status, reason: r.reason || ''
      };
    });

    // 담임 메모 맵
    const memoMap = {};
    const noticeMap = {};
    memos.forEach(m => {
      if (m.name === '__공지__') {
        noticeMap[`${m.grade}_${m.class_num}`] = m.status;
      } else {
        memoMap[`${m.grade}_${m.class_num}_${m.name}`] = `${m.status}|${m.reason || ''}`;
      }
    });

    // 연락처 맵
    const contactMap = {};
    contacts.forEach(c => {
      contactMap[`${c.grade}_${c.class_num}_${c.name}`] = c.phone || '';
    });

    // ⭐ 활동일지 — targetPeriod 기준 정확한 매칭 + recorder 반환
    const actLogMatched = (() => {
      if (!actLogs || actLogs.length === 0) return null;
      const exact = actLogs.find(log =>
        String(log.period || '').trim() === targetPeriod
      );
      if (exact) return exact;
      const partial = actLogs.find(log =>
        String(log.period || '')
          .split(/[,\-·\s]+/)
          .map(p => p.trim())
          .includes(targetPeriod)
      );
      return partial || null;
    })();

    const activityContent  = actLogMatched ? actLogMatched.content   || '' : '';
    const activityRecorder = actLogMatched ? actLogMatched.instructor || '' : '';
    
      if (!actLogs || actLogs.length === 0) return null;
      // 정확히 일치하는 period 먼저 찾기
      const exact = actLogs.find(log =>
        String(log.period || '').trim() === targetPeriod
      );
      if (exact) return exact;
      // 복합 교시 안에 포함되는 경우
      const partial = actLogs.find(log =>
        String(log.period || '')
          .split(/[,\-·\s]+/)
          .map(p => p.trim())
          .includes(targetPeriod)
      );
      return partial || null;
    })();

    const activityContent  = actLogMatched ? actLogMatched.content   || '' : '';
    const activityRecorder = actLogMatched ? actLogMatched.instructor || '' : '';

    // 학생 목록 구성
    const seen   = {};
    const result = [];
    students.forEach(s => {
      const key = `${s.grade}_${s.class_num}_${s.name}`;
      if (seen[key]) return;
      seen[key] = true;
      result.push({
        grade:          s.grade,
        classNum:       s.class_num,
        name:           s.name,
        permNote:       s.perm_note || '',
        dailyNote:      memoMap[key] || '',
        attendanceRate: 100,
        contact:        contactMap[key] || '',
        classNotice:    noticeMap[`${s.grade}_${s.class_num}`] || ''
      });
    });

    result.sort((a, b) => {
      if (a.grade   !== b.grade)   return a.grade   - b.grade;
      if (a.classNum !== b.classNum) return a.classNum - b.classNum;
      return a.name.localeCompare(b.name, 'ko-KR');
    });

    return { students: result, existing, activityContent, activityRecorder };
  },

  async saveAttendanceData(selectedDate, progName, day, period, attendanceList, isCanceled, substituteInstructor) {
    // 기존 기록 삭제
    await SUPABASE.delete('attendance',
      `?date=eq.${selectedDate}&program=eq.${encodeURIComponent(progName)}&period=eq.${encodeURIComponent(period)}`
    );

    const instructor = await this._getInstructor(progName);
    const recorder   = substituteInstructor
      ? `${substituteInstructor}(대체강사)`
      : instructor;
    const month = `${new Date(selectedDate + 'T00:00:00').getMonth() + 1}월`;
    const now   = new Date().toTimeString().slice(0, 8);
    // ⭐ F2: remark에 대체강사/소급입력 정보 기록
    const today  = new Date().toISOString().slice(0, 10);
    const isLate = selectedDate < today;
    const remark = [
      substituteInstructor ? `대체강사:${substituteInstructor}` : '',
      isLate ? '소급입력' : ''
    ].filter(Boolean).join(' / ');

    if (isCanceled) {
      await SUPABASE.insert('attendance', [{
        date: selectedDate, check_time: now,
        day: this._normalizeDay(day), period,
        program: progName, grade: null, class_num: null,
        name: '전체', status: '휴강', month, reason: '', recorder
      }]);
    } else {
      const rows = attendanceList.map(s => ({
        date: selectedDate, check_time: now,
        day: this._normalizeDay(day), period,
        program: progName, grade: s.grade, class_num: s.classNum,
        name: s.name, status: s.status,
        month, reason: s.reason || '', recorder
      }));
      if (rows.length > 0) await SUPABASE.insert('attendance', rows);
    }

    // ⭐ AB5 수정: attend_status만 업데이트 (activity_status 건드리지 않음)
    await this._updateSubmission(
      selectedDate, progName, period, this._normalizeDay(day),
      isCanceled ? '🚫 휴강' : '✅ 제출 완료',
      isCanceled ? '🚫 휴강' : undefined,  // 휴강 시에만 activity도 업데이트
      recorder,
      remark  // ⭐ F2: remark 전달
    );

    // 3연속 결석 체크
    const alerts = [];
    if (!isCanceled) {
      for (const s of attendanceList) {
        if (s.status === '결석') {
          const recent = await SUPABASE.select('attendance',
            `?program=eq.${encodeURIComponent(progName)}&name=eq.${encodeURIComponent(s.name)}&status=neq.휴강&order=date.desc&limit=3`
          );
          if (recent.length >= 3 && recent.every(r => r.status === '결석')) {
            alerts.push(`${s.grade}-${s.classNum} ${s.name}`);
          }
        }
      }
    }

    const summary = { present: 0, absent: 0, late: 0, leave: 0, total: 0 };
    if (!isCanceled) {
      attendanceList.forEach(s => {
        summary.total++;
        if      (s.status === '출석') summary.present++;
        else if (s.status === '결석') summary.absent++;
        else if (s.status === '지각') summary.late++;
        else if (s.status === '조퇴') summary.leave++;
      });
    }

    return { success: true, alerts, summary };
  },

  async saveActivityLog(selectedDate, progName, day, periods, activityContent, substituteInstructor) {
    // ⭐ B4 수정: periodList 정규화 강화
    const periodList = String(periods || '')
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);

    if (periodList.length === 0) {
      throw new Error('활동일지 저장 실패: 교시 정보가 없습니다.');
    }

    const firstPeriod = periodList[0];
    const lastPeriod  = periodList[periodList.length - 1];
    const PERIOD_TIME = {
      '5교시': { start: '13:10', end: '13:50' },
      '6교시': { start: '14:00', end: '14:40' },
      '7교시': { start: '14:50', end: '15:30' },
      '8교시': { start: '15:40', end: '16:20' }
    };

    const startTime = PERIOD_TIME[firstPeriod]?.start || '';
    const endTime   = PERIOD_TIME[lastPeriod]?.end   || '';
    const instructor = await this._getInstructor(progName);
    const recorder   = substituteInstructor ? substituteInstructor : instructor;
    const remark     = substituteInstructor ? `${substituteInstructor}(대체)` : '';
    const month      = `${new Date(selectedDate + 'T00:00:00').getMonth() + 1}월`;
    const dateObj    = new Date(selectedDate + 'T00:00:00');
    const dayNames   = ['일', '월', '화', '수', '목', '금', '토'];
    const dayOfWeek  = day ? this._normalizeDay(day) : dayNames[dateObj.getDay()];
    const periodText = periodList.length === 1
      ? firstPeriod
      : `${firstPeriod}-${lastPeriod}`;

    const rowData = {
      date:       selectedDate,
      day:        dayOfWeek,
      program:    progName,
      instructor: recorder,
      period:     periodText,
      start_time: startTime,
      end_time:   endTime,
      content:    activityContent,
      remark,
      month
    };

    // ⭐ B4 수정: id 기반으로 정확한 UPDATE
    // ⭐ 중복 방지: 기존 row 전체 삭제 후 새로 INSERT
    // (UNIQUE 제약이 없는 경우 중복 row 누적 방지)
    const existing = await SUPABASE.select('activity_logs',
      `?date=eq.${selectedDate}&program=eq.${encodeURIComponent(progName)}&period=eq.${encodeURIComponent(periodText)}&select=id`
    );

    if (existing.length > 0) {
      // 가장 최신 row 하나만 UPDATE, 나머지 중복 삭제
      await SUPABASE.update('activity_logs', rowData, `?id=eq.${existing[0].id}`);
      if (existing.length > 1) {
        const deleteIds = existing.slice(1).map(r => r.id).filter(Boolean);
        if (deleteIds.length > 0) {
          await SUPABASE.delete('activity_logs', `?id=in.(${deleteIds.join(',')})`);
        }
      }
    } else {
      await SUPABASE.insert('activity_logs', [rowData]);
    }

    // ⭐ AB5 수정: 각 교시별로 activity_status만 업데이트
    for (const targetPeriod of periodList) {
      await this._updateSubmission(
        selectedDate, progName, targetPeriod, dayOfWeek,
        undefined,         // attend_status 건드리지 않음
        '✅ 제출 완료',    // activity_status만 업데이트
        recorder,
        remark
      );
    }

    return { success: true };
  },

  async getExistingAttendance(selectedDate, progName, day, period) {
    const data = await SUPABASE.select('attendance',
      `?date=eq.${selectedDate}&program=eq.${encodeURIComponent(progName)}&period=eq.${encodeURIComponent(period)}`
    );
    const result = {};
    data.forEach(r => {
      result[`${r.grade}_${r.class_num}_${r.name}`] = {
        status: r.status, reason: r.reason || ''
      };
    });
    return result;
  },

  // ==========================================
  // 🟢 담임
  // ==========================================

  async getHomeroomStudents(grade, classNum, targetDate) {
    const [students, memos] = await Promise.all([
      SUPABASE.select('students',
        `?grade=eq.${grade}&class_num=eq.${classNum}&select=name`
      ),
      SUPABASE.select('pre_memos',
        `?date=eq.${targetDate}&grade=eq.${grade}&class_num=eq.${classNum}`
      )
    ]);

    const uniqueNames = [...new Set(students.map(s => s.name))];
    const memoMap     = {};
    memos.forEach(m => {
      if (m.name !== '__공지__') {
        memoMap[m.name] = `${m.status}|${m.reason || ''}`;
      }
    });

    return uniqueNames
      .sort((a, b) => a.localeCompare(b, 'ko-KR'))
      .map(name => ({ name, dailyNote: memoMap[name] || '' }));
  },

  async saveHomeroomMemos(grade, classNum, memoData, targetDate) {
    await SUPABASE.delete('pre_memos',
      `?date=eq.${targetDate}&grade=eq.${grade}&class_num=eq.${classNum}&name=neq.__공지__`
    );

    const rows = memoData
      .filter(m => m.note && m.note.trim() !== '')
      .map(m => {
        const parts = m.note.split('|');
        return {
          date:      targetDate,
          grade:     parseInt(grade),
          class_num: parseInt(classNum),
          name:      m.name,
          status:    parts[0]?.trim() || '',
          reason:    parts[1]?.trim() || ''
        };
      })
      .filter(r => r.status);

    if (rows.length > 0) await SUPABASE.insert('pre_memos', rows);
    return true;
  },

  async getHomeroomTodayStatus(grade, classNum, targetDate) {
    const data = await SUPABASE.select('attendance',
      `?date=eq.${targetDate}&grade=eq.${grade}&class_num=eq.${classNum}`
    );
    return data.map(r => ({
      prog:   r.program,
      period: r.period,
      name:   r.name,
      status: r.status,
      reason: r.reason || ''
    }));
  },

  async getHomeroomAttendance(grade, classNum, month) {
    const data = await SUPABASE.select('attendance',
      `?grade=eq.${grade}&class_num=eq.${classNum}&month=eq.${encodeURIComponent(month)}&status=neq.휴강&order=date.asc,program.asc`
    );

    const studentStats = {};
    data.forEach(r => {
      if (!studentStats[r.name]) {
        studentStats[r.name] = {
          present: 0, absent: 0, late: 0, leave: 0, total: 0
        };
      }
      studentStats[r.name].total++;
      if      (r.status === '출석') studentStats[r.name].present++;
      else if (r.status === '결석') studentStats[r.name].absent++;
      else if (r.status === '지각') studentStats[r.name].late++;
      else if (r.status === '조퇴') studentStats[r.name].leave++;
    });

    const studentList = Object.keys(studentStats)
      .sort((a, b) => a.localeCompare(b, 'ko-KR'))
      .map(name => {
        const s = studentStats[name];
        return {
          name,
          present: s.present,
          absent:  s.absent,
          late:    s.late,
          leave:   s.leave,
          total:   s.total,
          rate:    s.total > 0 ? Math.round((s.present / s.total) * 100) : 0
        };
      });

    // ⭐ AB8 수정: records도 반환 (날짜별 상세 표에 필요)
    return { records: data, studentList };
  },

  async saveClassNotice(grade, classNum, notice) {
    const today = new Date().toISOString().slice(0, 10);
    await SUPABASE.delete('pre_memos',
      `?date=eq.${today}&grade=eq.${grade}&class_num=eq.${classNum}&name=eq.__공지__`
    );
    if (notice && notice.trim()) {
      await SUPABASE.insert('pre_memos', [{
        date:      today,
        grade:     parseInt(grade),
        class_num: parseInt(classNum),
        name:      '__공지__',
        status:    notice.trim(),
        reason:    ''
      }]);
    }
    return { success: true };
  },

  async getClassNotice(grade, classNum) {
    const today = new Date().toISOString().slice(0, 10);
    const data  = await SUPABASE.select('pre_memos',
      `?date=eq.${today}&grade=eq.${grade}&class_num=eq.${classNum}&name=eq.__공지__`
    );
    return data.length > 0 ? data[0].status : '';
  },

  // ==========================================
  // 🟣 관리자
  // ==========================================

  async getAdminAllData(targetDate, periodType) {
    const dateRange = this._getDateRange(periodType, targetDate);

    const [allAttendance, submit] = await Promise.all([
      SUPABASE.select('attendance',
        `?date=gte.${dateRange.startDate}&date=lte.${dateRange.endDate}&order=date.asc,program.asc,period.asc,grade.asc,class_num.asc,name.asc`
      ),
      this.getSubmissionStatus(targetDate, periodType)
    ]);

    const mapRecord = r => ({
      _id: r.id,
      recordKey: {
        id:       r.id,
        date:     r.date,
        prog:     r.program,
        period:   r.period,
        grade:    String(r.grade),
        classNum: String(r.class_num),
        name:     r.name
      },
      date:     r.date,
      prog:     r.program,
      period:   r.period,
      grade:    r.grade,
      classNum: r.class_num,
      name:     r.name,
      status:   r.status,
      reason:   r.reason   || '',
      recorder: r.recorder || ''
    });

    // daily 통계
    const dailyData  = allAttendance.filter(r => r.date === targetDate);
    const progStats  = {};
    dailyData.forEach(r => {
      if (!progStats[r.program]) {
        progStats[r.program] = { total: 0, present: 0, absent: 0, late: 0, leave: 0 };
      }
      progStats[r.program].total++;
      if      (r.status === '출석') progStats[r.program].present++;
      else if (r.status === '결석') progStats[r.program].absent++;
      else if (r.status === '지각') progStats[r.program].late++;
      else if (r.status === '조퇴') progStats[r.program].leave++;
    });

    const daily = {
      present:  dailyData.filter(r => r.status === '출석').length,
      absent:   dailyData.filter(r => r.status === '결석').length,
      late:     dailyData.filter(r => r.status === '지각').length,
      leave:    dailyData.filter(r => r.status === '조퇴').length,
      canceled: dailyData.filter(r => r.status === '휴강').length,
      progStats,
      records: dailyData.map(mapRecord)
    };

    // multi 통계
    const multiProgStats  = {};
    const datesByProg     = {};
    const studentStatsMap = {};
    const totalStats      = { present: 0, absent: 0, late: 0, leave: 0, canceled: 0 };

    allAttendance.forEach(r => {
      if (r.status === '휴강') { totalStats.canceled++; return; }
      if (!multiProgStats[r.program]) {
        multiProgStats[r.program] = { present: 0, absent: 0, late: 0, leave: 0, canceled: 0 };
      }
      if (!datesByProg[r.program]) datesByProg[r.program] = {};
      datesByProg[r.program][r.date] = true;
      if      (r.status === '출석') { multiProgStats[r.program].present++; totalStats.present++; }
      else if (r.status === '결석') { multiProgStats[r.program].absent++;  totalStats.absent++;  }
      else if (r.status === '지각') { multiProgStats[r.program].late++;    totalStats.late++;    }
      else if (r.status === '조퇴') { multiProgStats[r.program].leave++;   totalStats.leave++;   }
    });

    Object.keys(datesByProg).forEach(prog => {
      multiProgStats[prog].classDays = Object.keys(datesByProg[prog]).length;
    });

    allAttendance.filter(r => r.status !== '휴강').forEach(r => {
      const key = `${r.grade}_${r.class_num}_${r.name}_${r.program}`;
      if (!studentStatsMap[key]) {
        studentStatsMap[key] = {
          grade: r.grade, classNum: r.class_num, name: r.name, prog: r.program,
          present: 0, absent: 0, late: 0, leave: 0, total: 0
        };
      }
      studentStatsMap[key].total++;
      if      (r.status === '출석') studentStatsMap[key].present++;
      else if (r.status === '결석') studentStatsMap[key].absent++;
      else if (r.status === '지각') studentStatsMap[key].late++;
      else if (r.status === '조퇴') studentStatsMap[key].leave++;
    });

    const studentList = Object.values(studentStatsMap).map(s => ({
      ...s,
      rate: s.total > 0 ? Math.round((s.present / s.total) * 100) : 0
    })).sort((a, b) => a.rate - b.rate);

    const multi = {
      periodType,
      startDate:    dateRange.startDate,
      endDate:      dateRange.endDate,
      totalStats,
      progStats:    multiProgStats,
      studentList,
      records:      allAttendance.map(mapRecord),
      absentStudents: [],
      sheet3: [],
      sheet4: []
    };

    return { daily, multi, submit, lateSubmitCount: submit.lateSubmitCount || 0 };
  },

  async getRecordsByPeriod(targetDate, periodType) {
    const dateRange = this._getDateRange(periodType, targetDate);
    const data = await SUPABASE.select('attendance',
      `?date=gte.${dateRange.startDate}&date=lte.${dateRange.endDate}&order=date.asc,program.asc,period.asc,grade.asc,class_num.asc,name.asc`
    );
    const records = data.map(r => ({
      _id: r.id,
      recordKey: {
        id:       r.id,
        date:     r.date,
        prog:     r.program,
        period:   r.period,
        grade:    String(r.grade),
        classNum: String(r.class_num),
        name:     r.name
      },
      date:     r.date,
      prog:     r.program,
      period:   r.period,
      grade:    r.grade,
      classNum: r.class_num,
      name:     r.name,
      status:   r.status,
      reason:   r.reason   || '',
      recorder: r.recorder || ''
    }));
    return { records, startDate: dateRange.startDate, endDate: dateRange.endDate };
  },
  async updateAdminRecord(recordKey, newStatus, newReason) {
    if (!recordKey || !recordKey.id) {
      throw new Error('수정 대상 id가 없습니다. 새로고침 후 다시 시도해주세요.');
    }
    const updated = await SUPABASE.update(
      'attendance',
      { status: newStatus, reason: newReason || '' },
      `?id=eq.${recordKey.id}`
    );
    return Array.isArray(updated) && updated.length > 0;
  },

  async getSubmissionStatus(targetDate, periodType) {
    const dateRange = this._getDateRange(periodType, targetDate);
    return this._buildRealtimeSubmissionData(dateRange);
  },

  async generateAbsentMessages(targetDate, periodType) {
    const dateRange = this._getDateRange(periodType, targetDate);
    const allRecords = await SUPABASE.select('attendance',
      `?date=gte.${dateRange.startDate}&date=lte.${dateRange.endDate}&status=neq.휴강&order=date.asc,program.asc,grade.asc,class_num.asc,name.asc`
    );

    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    const statsByStudentProgram = {};

    allRecords.forEach(r => {
      const key = `${r.grade}_${r.class_num}_${r.name}_${r.program}`;
      if (!statsByStudentProgram[key]) {
        statsByStudentProgram[key] = {
          grade: r.grade, classNum: r.class_num, name: r.name, prog: r.program,
          present: 0, absent: 0, late: 0, leave: 0, total: 0, absences: []
        };
      }
      const stat = statsByStudentProgram[key];
      stat.total++;
      if (r.status === '출석') stat.present++;
      else if (r.status === '결석') {
        stat.absent++;
        const dateObj = new Date(r.date + 'T00:00:00');
        stat.absences.push({
          date:        r.date,
          day:         dayNames[dateObj.getDay()],
          dateDisplay: `${parseInt(r.date.split('-')[1])}/${parseInt(r.date.split('-')[2])}(${dayNames[dateObj.getDay()]})`,
          prog:        r.program,
          period:      r.period,
          reason:      r.reason || '사유 미등록'
        });
      }
      else if (r.status === '지각') stat.late++;
      else if (r.status === '조퇴') stat.leave++;
    });

    const getAbsenceGuide = count => {
      if (count >= 5) return '지속적인 결석이 누적되고 있어 보호자 상담 및 출결 관리가 필요합니다.';
      if (count === 4) return '결석이 4회 누적되었습니다. 반복 결석 원인 확인과 상담을 권장드립니다.';
      if (count === 3) return '결석이 3회 누적되었습니다. 이후 출결에 각별한 관심 부탁드립니다.';
      if (count === 2) return '결석이 반복되고 있습니다. 다음 수업 참여 여부를 확인해주세요.';
      return '결석 사실을 안내드립니다. 다음 수업 참여 여부를 확인해주세요.';
    };

    const isDaily = !periodType || periodType === 'daily';
    const messages = [];
    const absentStats = Object.values(statsByStudentProgram)
      .filter(s => s.absent > 0)
      .sort((a, b) => {
        if (a.grade   !== b.grade)   return a.grade   - b.grade;
        if (a.classNum !== b.classNum) return a.classNum - b.classNum;
        return a.name.localeCompare(b.name, 'ko-KR');
      });

    absentStats.forEach(s => {
      const rate  = s.total > 0 ? Math.round((s.present / s.total) * 100) : 0;
      const guide = getAbsenceGuide(s.absent);

      if (isDaily) {
        s.absences.forEach(a => {
          let msg  = '[순창초 방과후학교 안내]\n학부모님 안녕하세요.\n';
          msg += `${s.grade}학년 ${s.classNum}반 ${s.name} 학생이 [${a.prog}] 수업(${a.day}요일 ${a.period})에 결석하였습니다.\n`;
          msg += `• 사유: ${a.reason}\n• 누적 결석: ${s.absent}회\n• 현재 출석률: ${rate}%\n`;
          msg += `• 안내: ${guide}\n\n문의: 순창초 늘봄지원실`;
          messages.push({ name: `${s.grade}-${s.classNum} ${s.name}`, prog: a.prog, absentCount: s.absent, rate, message: msg });
        });
      } else {
        let msg = '[순창초 방과후학교 안내]\n학부모님 안녕하세요.\n';
        msg += `${s.grade}학년 ${s.classNum}반 ${s.name} 학생의 방과후학교 결석 현황을 안내드립니다.\n\n`;
        s.absences.forEach(a => { msg += `• ${a.dateDisplay} [${a.prog}] ${a.period} - ${a.reason}\n`; });
        msg += `\n• 결석: ${s.absent}회\n• 출석률: ${rate}%\n• 안내: ${guide}\n\n문의: 순창초 늘봄지원실`;
        messages.push({ name: `${s.grade}-${s.classNum} ${s.name}`, prog: s.prog, absentCount: s.absent, rate, message: msg });
      }
    });

    const studentCount = absentStats.length;
    let summaryMsg = '';
    if (studentCount > 0) {
      summaryMsg = `[결석 현황 요약]\n총 ${studentCount}명 결석\n\n`;
      absentStats.forEach((s, i) => {
        const rate = s.total > 0 ? Math.round((s.present / s.total) * 100) : 0;
        summaryMsg += `${i + 1}. ${s.grade}-${s.classNum} ${s.name} | ${s.prog} | 결석 ${s.absent}회 | 출석률 ${rate}%\n`;
      });
    }

    return {
      individual: messages, summary: summaryMsg,
      count: messages.length, studentCount,
      startDate: dateRange.startDate, endDate: dateRange.endDate
    };
  },

  // ==========================================
  // 📄 서류 관리
  // ==========================================

  async getAttendanceDocList() {
    const data = await SUPABASE.select('doc_history',
      '?select=month,doc_type,created_at,updated_at,status&order=month.desc,doc_type.asc'
    );
    return data.map(d => ({
      month:     d.month,
      docType:   d.doc_type,
      url:       '',
      createdAt: d.created_at || '-',
      updatedAt: d.updated_at || '-',
      status:    d.status     || '작업중'
    }));
  },

  async generateAttendanceDoc(month, targetProg) {
    await generateAttendancePDF(month, targetProg || '전체');
    const now = new Date().toLocaleString('ko-KR');
    const existing = await SUPABASE.select('doc_history',
      `?month=eq.${encodeURIComponent(month)}&doc_type=eq.출석부`
    );
    if (existing.length > 0) {
      await SUPABASE.update('doc_history',
        { updated_at: now, status: '작업중' },
        `?month=eq.${encodeURIComponent(month)}&doc_type=eq.출석부`
      );
    } else {
      await SUPABASE.insert('doc_history', [{
        month, doc_type: '출석부', created_at: now, updated_at: now, status: '작업중'
      }]);
    }
    return { success: true, url: '', isUpdate: existing.length > 0 };
  },

  async generateActivityDoc(month, targetProg) {
    await generateActivityPDF(month, targetProg || '전체');
    const now = new Date().toLocaleString('ko-KR');
    const existing = await SUPABASE.select('doc_history',
      `?month=eq.${encodeURIComponent(month)}&doc_type=eq.활동일지`
    );
    if (existing.length > 0) {
      await SUPABASE.update('doc_history',
        { updated_at: now, status: '작업중' },
        `?month=eq.${encodeURIComponent(month)}&doc_type=eq.활동일지`
      );
    } else {
      await SUPABASE.insert('doc_history', [{
        month, doc_type: '활동일지', created_at: now, updated_at: now, status: '작업중'
      }]);
    }
    return { success: true, url: '', isUpdate: existing.length > 0 };
  },

  async finalizeMonth(month, docType) {
    const now = new Date().toLocaleString('ko-KR');
    await SUPABASE.update('doc_history',
      { status: '확정', updated_at: now },
      `?month=eq.${encodeURIComponent(month)}&doc_type=eq.${encodeURIComponent(docType)}`
    );
    return { success: true, message: `${month} ${docType} 마감 완료` };
  },

  async setMonthFinalized(month, shouldFinalize) {
    const now           = new Date().toLocaleString('ko-KR');
    const requiredTypes = ['출석부', '활동일지'];
    const existing      = await SUPABASE.select('doc_history',
      `?month=eq.${encodeURIComponent(month)}&select=id,doc_type,status`
    );
    const existingTypes = new Set((existing || []).map(d => d.doc_type));
    const missingTypes  = requiredTypes.filter(t => !existingTypes.has(t));

    if (missingTypes.length > 0) {
      return {
        success: false,
        message: `${month} ${missingTypes.join(', ')} 문서가 없습니다. 먼저 생성/갱신하세요.`
      };
    }

    const nextStatus = shouldFinalize ? '확정' : '작업중';
    for (const docType of requiredTypes) {
      await SUPABASE.update('doc_history',
        { status: nextStatus, updated_at: now },
        `?month=eq.${encodeURIComponent(month)}&doc_type=eq.${encodeURIComponent(docType)}`
      );
    }
    return {
      success: true,
      status:  nextStatus,
      message: shouldFinalize ? `${month} 월 마감 완료` : `${month} 월 마감 해지 완료`
    };
  },

  // ==========================================
  // 👤 학생 관리
  // ==========================================

  async getAdminStudentList(grade, classNum, targetDate) {
    let params = '?select=grade,class_num,name,perm_note';
    if (grade    !== '전체') params += `&grade=eq.${grade}`;
    if (classNum !== '전체') params += `&class_num=eq.${classNum}`;

    const [studentsRaw, memos] = await Promise.all([
      SUPABASE.select('students', params),
      SUPABASE.select('pre_memos',
        `?date=eq.${targetDate}${grade !== '전체' ? `&grade=eq.${grade}` : ''}${classNum !== '전체' ? `&class_num=eq.${classNum}` : ''}&name=neq.__공지__`
      )
    ]);

    const seen     = {};
    const students = [];
    studentsRaw.forEach(s => {
      const key = `${s.grade}_${s.class_num}_${s.name}`;
      if (!seen[key]) { seen[key] = true; students.push(s); }
    });

    const memoMap = {};
    memos.forEach(m => {
      memoMap[`${m.grade}_${m.class_num}_${m.name}`] = `${m.status}|${m.reason || ''}`;
    });

    return students
      .sort((a, b) => {
        if (a.grade     !== b.grade)     return a.grade     - b.grade;
        if (a.class_num !== b.class_num) return a.class_num - b.class_num;
        return a.name.localeCompare(b.name, 'ko-KR');
      })
      .map(s => ({
        grade:     s.grade,
        classNum:  s.class_num,
        name:      s.name,
        permNote:  s.perm_note || '',
        dailyNote: memoMap[`${s.grade}_${s.class_num}_${s.name}`] || ''
      }));
  },

  async saveAdminDailyNotes(grade, classNum, memoData) {
    const today = new Date().toISOString().slice(0, 10);
    await SUPABASE.delete('pre_memos',
      `?date=eq.${today}&grade=eq.${grade}&class_num=eq.${classNum}&name=neq.__공지__`
    );
    const rows = memoData
      .filter(m => m.note && m.note.trim())
      .map(m => {
        const parts = m.note.split('|');
        return {
          date: today, grade: parseInt(grade), class_num: parseInt(classNum),
          name: m.name, status: parts[0]?.trim() || '', reason: parts[1]?.trim() || ''
        };
      })
      .filter(r => r.status);
    if (rows.length > 0) await SUPABASE.insert('pre_memos', rows);
    return true;
  },

  async savePermNote(grade, classNum, name, permNote) {
    await SUPABASE.update('students',
      { perm_note: permNote },
      `?grade=eq.${grade}&class_num=eq.${classNum}&name=eq.${encodeURIComponent(name)}`
    );
    return true;
  },

  async getActivityLogList(month, progName) {
    let params = `?month=eq.${encodeURIComponent(month)}`;
    if (progName && progName !== '전체') {
      params += `&program=eq.${encodeURIComponent(progName)}`;
    }
    const data = await SUPABASE.select('activity_logs', params + '&order=program.asc,date.asc');
    return data.map((item, idx) => ({
      rowIndex:   idx,
      date:       item.date,
      day:        item.day,
      prog:       item.program,
      instructor: item.instructor,
      period:     item.period,
      startTime:  item.start_time,
      endTime:    item.end_time,
      content:    item.content || '',
      remark:     item.remark  || '',
      _id:        item.id
    }));
  },

  async updateActivityLog(itemId, newContent) {
    if (!itemId) return false;
    await SUPABASE.update('activity_logs', { content: newContent }, `?id=eq.${itemId}`);
    return true;
  },

  async getInstMissingList(progName, month) {
    const dateRange = this._getDateRangeByMonth(month);
    const result    = await this._buildRealtimeSubmissionData(dateRange, progName);
    const today     = new Date().toISOString().slice(0, 10);

    return (result.notSubmitted || [])
      .filter(item => item.date <= today)
      .map(item => ({
        date:         item.date,
        day:          item.day,
        period:       item.period,
        prog:         item.prog,
        instructor:   item.instructor,
        attendDone:   this._isDoneStatus(item.attendStatus),
        activityDone: this._isDoneStatus(item.activityStatus)
      }))
      .filter(item => !(item.attendDone && item.activityDone))
      .sort((a, b) => a.date.localeCompare(b.date) || a.period.localeCompare(b.period));
  },

  // ==========================================
  // 🔧 내부 헬퍼 함수
  // ==========================================

  // ⭐ 강사명 캐시 조회 (AB9: 중복 API 호출 방지)
  async _getInstructor(progName) {
    if (this._instructorCache[progName] !== undefined) {
      return this._instructorCache[progName];
    }
    const data = await SUPABASE.select('instructors',
      `?program=eq.${encodeURIComponent(progName)}&select=instructor_name`
    );
    const name = data.length > 0 ? data[0].instructor_name : '';
    this._instructorCache[progName] = name;
    return name;
  },

  // ⭐ _updateSubmission 전면 재작성 (B2 + AB4 + AB5 수정)
  async _updateSubmission(date, program, period, day, attendStatus, activityStatus, instructor, remark) {
    const targetDate      = String(date     || '').trim();
    const targetProgram   = String(program  || '').trim();
    const targetPeriod    = String(period   || '').trim();
    const targetDay       = String(day      || '').trim();
    const targetInstructor = String(instructor || '').trim();
    const targetRemark    = String(remark   || '').trim();

    // ⭐ period 없으면 건너뜀 (AB4 수정)
    if (!targetDate || !targetProgram || !targetPeriod) return;

    const today   = new Date().toISOString().slice(0, 10);
    const isLate  = targetDate < today;
    const month   = `${new Date(targetDate + 'T00:00:00').getMonth() + 1}월`;
    const nowTime = new Date().toTimeString().slice(0, 8);
    const lateTime = new Date().toISOString().slice(0, 16).replace('T', ' ');

    const params =
      `?date=eq.${targetDate}` +
      `&program=eq.${encodeURIComponent(targetProgram)}` +
      `&period=eq.${encodeURIComponent(targetPeriod)}`;

    const existing = await SUPABASE.select('submissions', params + '&select=*');

    if (existing && existing.length > 0) {
      const keep       = existing[0];
      const updateData = {
        day:         targetDay        || keep.day    || '',
        month,
        submit_time: nowTime
      };

      if (targetInstructor)                   updateData.instructor = targetInstructor;
      // ⭐ AB5 수정: undefined면 건드리지 않음
      if (attendStatus  !== undefined && attendStatus  !== null) {
        updateData.attend_status = attendStatus;
      }
      if (activityStatus !== undefined && activityStatus !== null) {
        updateData.activity_status = activityStatus;
      }
      if (isLate && !keep.late_submit) {
        updateData.late_submit      = '✅ 소급입력';
        updateData.late_submit_time = lateTime;
      }
      // ⭐ F2: remark 업데이트
      if (targetRemark) updateData.remark = targetRemark;

      await SUPABASE.update('submissions', updateData, `?id=eq.${keep.id}`);

      // 중복 행 제거
      if (existing.length > 1) {
        const deleteIds = existing.slice(1).map(r => r.id).filter(Boolean);
        if (deleteIds.length > 0) {
          await SUPABASE.delete('submissions', `?id=in.(${deleteIds.join(',')})`);
        }
      }
      return true;
    }

    // 신규 삽입
    const insertRow = {
      date:             targetDate,
      day:              targetDay,
      period:           targetPeriod,
      program:          targetProgram,
      instructor:       targetInstructor,
      attend_status:    attendStatus    !== undefined ? attendStatus    : '❌ 미제출',
      activity_status:  activityStatus  !== undefined ? activityStatus  : '❌ 미제출',
      submit_time:      nowTime,
      month,
      remark:           targetRemark,
      late_submit:      isLate ? '✅ 소급입력' : '',
      late_submit_time: isLate ? lateTime : ''
    };

    try {
      await SUPABASE.insert('submissions', [insertRow]);
      return true;
    } catch (err) {
      // INSERT 실패 시 재조회 후 UPDATE (race condition 대응)
      const retry = await SUPABASE.select('submissions', params + '&select=*');
      if (retry && retry.length > 0) {
        const retryUpdate = { day: targetDay || '', month, submit_time: nowTime };
        if (targetInstructor) retryUpdate.instructor = targetInstructor;
        if (attendStatus  !== undefined && attendStatus  !== null) retryUpdate.attend_status   = attendStatus;
        if (activityStatus !== undefined && activityStatus !== null) retryUpdate.activity_status = activityStatus;
        if (isLate && !retry[0].late_submit) {
          retryUpdate.late_submit      = '✅ 소급입력';
          retryUpdate.late_submit_time = lateTime;
        }
        if (targetRemark) retryUpdate.remark = targetRemark;
        await SUPABASE.update('submissions', retryUpdate, `?id=eq.${retry[0].id}`);
        return true;
      }
      throw err;
    }
  },

  _normalizeDay(day) {
    return String(day || '').replace('요일', '').trim();
  },

  _isDoneStatus(status) {
    const cleaned = String(status || '')
      .replace(/\s/g, '')
      .replace(/[^\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/g, '');
    return cleaned.includes('제출완료') || cleaned.includes('휴강');
  },

  _activityMatchesPeriod(logPeriod, targetPeriod) {
    const log    = String(logPeriod    || '').trim();
    const target = String(targetPeriod || '').trim();
    if (!log || !target) return false;
    if (log === target)  return true;
    return log.split(/[,/·\-\s]+/).map(p => p.trim()).includes(target);
  },

  _dateList(startDate, endDate) {
    const dates = [];
    const cur   = new Date(startDate + 'T00:00:00');
    const end   = new Date(endDate   + 'T00:00:00');
    while (cur <= end) {
      dates.push(cur.toISOString().slice(0, 10));
      cur.setDate(cur.getDate() + 1);
    }
    return dates;
  },

  _getDateRangeByMonth(monthText) {
    const monthNum = parseInt(String(monthText || '').replace(/[^0-9]/g, ''), 10);
    const today    = new Date();
    const year     = today.getFullYear();
    if (!monthNum || monthNum < 1 || monthNum > 12) {
      const current = String(today.getMonth() + 1).padStart(2, '0');
      const last    = new Date(year, today.getMonth() + 1, 0).getDate();
      return {
        startDate: `${year}-${current}-01`,
        endDate:   `${year}-${current}-${String(last).padStart(2, '0')}`
      };
    }
    const mm      = String(monthNum).padStart(2, '0');
    const lastDay = new Date(year, monthNum, 0).getDate();
    return {
      startDate: `${year}-${mm}-01`,
      endDate:   `${year}-${mm}-${String(lastDay).padStart(2, '0')}`
    };
  },

  async _safeSelect(table, params) {
    try {
      return await SUPABASE.select(table, params);
    } catch (err) {
      console.warn(`[${table}] 조회 실패:`, err.message);
      return [];
    }
  },

  async _getOperationExceptions(dateRange) {
    return await this._safeSelect('operation_exceptions',
      `?start_date=lte.${dateRange.endDate}&end_date=gte.${dateRange.startDate}`
    );
  },

  _isExceptionDate(dateStr, exceptions) {
    return (exceptions || []).some(row =>
      row.start_date <= dateStr && row.end_date >= dateStr
    );
  },

  _buildAttendanceMap(records) {
    const map = {};
    (records || []).forEach(r => {
      const key = `${r.date}|${r.program}|${r.period}`;
      if (!map[key]) map[key] = [];
      map[key].push(r);
    });
    return map;
  },

  _buildActivityMap(records) {
    const map = {};
    (records || []).forEach(r => {
      const key = `${r.date}|${r.program}`;
      if (!map[key]) map[key] = [];
      map[key].push(r);
    });
    return map;
  },

  async _buildExpectedLessons(dateRange, progName) {
    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    const [students, instructors, exceptions] = await Promise.all([
      SUPABASE.select('students', '?select=day,period,program'),
      this._safeSelect('instructors', '?select=program,instructor_name'),
      this._getOperationExceptions(dateRange)
    ]);

    const instructorMap = {};
    (instructors || []).forEach(i => { instructorMap[i.program] = i.instructor_name || ''; });

    const schedule = {};
    (students || []).forEach(s => {
      if (!s.program || !s.day || !s.period) return;
      if (progName && s.program !== progName)  return;
      const day = this._normalizeDay(s.day);
      const key = `${day}|${s.period}|${s.program}`;
      if (!schedule[key]) {
        schedule[key] = {
          day, period: s.period, program: s.program,
          instructor: instructorMap[s.program] || ''
        };
      }
    });

    const lessons = [];
    this._dateList(dateRange.startDate, dateRange.endDate).forEach(date => {
      const d   = new Date(date + 'T00:00:00');
      const dow = d.getDay();
      if (dow === 0 || dow === 6) return;
      if (this._isExceptionDate(date, exceptions)) return;
      const day = dayNames[dow];
      Object.values(schedule).forEach(item => {
        if (item.day === day) {
          lessons.push({
            date, day, period: item.period,
            program: item.program, instructor: item.instructor
          });
        }
      });
    });

    lessons.sort((a, b) =>
      a.date.localeCompare(b.date) ||
      a.program.localeCompare(b.program, 'ko-KR') ||
      a.period.localeCompare(b.period)
    );
    return lessons;
  },

  async _buildRealtimeSubmissionData(dateRange, progName) {
    const [expectedLessons, attendance, activityLogs, submissions] = await Promise.all([
      this._buildExpectedLessons(dateRange, progName),
      SUPABASE.select('attendance',
        `?date=gte.${dateRange.startDate}&date=lte.${dateRange.endDate}`
      ),
      SUPABASE.select('activity_logs',
        `?date=gte.${dateRange.startDate}&date=lte.${dateRange.endDate}`
      ),
      this._safeSelect('submissions',
        `?date=gte.${dateRange.startDate}&date=lte.${dateRange.endDate}`
      )
    ]);

    const attendanceMap = this._buildAttendanceMap(attendance);
    const activityMap   = this._buildActivityMap(activityLogs);
    const submitted     = [];
    const notSubmitted  = [];
    const lateSubmits   = [];

    expectedLessons.forEach(lesson => {
      const key        = `${lesson.date}|${lesson.program}|${lesson.period}`;
      const attRows    = attendanceMap[key] || [];
      const isCanceled = attRows.some(r => r.status === '휴강');
      const attendDone = isCanceled || attRows.filter(r => r.status !== '휴강').length > 0;
      const actRows    = (activityMap[`${lesson.date}|${lesson.program}`] || [])
        .filter(log => this._activityMatchesPeriod(log.period, lesson.period));
      const activityDone = isCanceled || actRows.length > 0;

      const obj = {
        date:           lesson.date,
        day:            lesson.day,
        period:         lesson.period,
        prog:           lesson.program,
        instructor:     lesson.instructor || '',
        attendStatus:   isCanceled ? '🚫 휴강' : (attendDone   ? '✅ 제출 완료' : '❌ 미제출'),
        activityStatus: isCanceled ? '🚫 휴강' : (activityDone ? '✅ 제출 완료' : '❌ 미제출'),
        submitTime:     '',
        lateSubmit:     '',
        lateSubmitTime: ''
      };

      if (attendDone && activityDone) submitted.push(obj);
      else notSubmitted.push(obj);
    });

    // 소급입력 이력 (submissions 테이블에서)
    (submissions || []).forEach(item => {
      if (item.late_submit === '✅ 소급입력') {
        lateSubmits.push({
          date:           item.date,
          day:            item.day,
          period:         item.period,
          prog:           item.program,
          instructor:     item.instructor    || '',
          attendStatus:   item.attend_status,
          activityStatus: item.activity_status,
          submitTime:     item.submit_time   || '',
          lateSubmit:     item.late_submit   || '',
          lateSubmitTime: item.late_submit_time || ''
        });
      }
    });

    submitted.sort((a, b) =>
      a.date.localeCompare(b.date) ||
      a.period.localeCompare(b.period) ||
      a.prog.localeCompare(b.prog, 'ko-KR')
    );
    notSubmitted.sort((a, b) =>
      a.date.localeCompare(b.date) ||
      a.period.localeCompare(b.period) ||
      a.prog.localeCompare(b.prog, 'ko-KR')
    );
    lateSubmits.sort((a, b) => b.date.localeCompare(a.date));

    return {
      total:            submitted.length + notSubmitted.length,
      submittedCount:   submitted.length,
      notSubmittedCount: notSubmitted.length,
      submitted,
      notSubmitted,
      history:          [],
      lateSubmits,
      lateSubmitCount:  lateSubmits.length,
      startDate:        dateRange.startDate,
      endDate:          dateRange.endDate
    };
  },

  _getDateRange(periodType, dateValue) {
    const d = new Date(dateValue + 'T00:00:00');
    let startDate, endDate;

    switch (periodType) {
      case 'daily':
        startDate = endDate = dateValue;
        break;

      case 'weekly': {
        const dow          = d.getDay();
        const mondayOffset = dow === 0 ? -6 : 1 - dow;
        const monday       = new Date(d);
        monday.setDate(d.getDate() + mondayOffset);
        const friday = new Date(monday);
        friday.setDate(monday.getDate() + 4);
        startDate = monday.toISOString().slice(0, 10);
        endDate   = friday.toISOString().slice(0, 10);
        break;
      }

      case 'monthly': {
        startDate       = dateValue.slice(0, 7) + '-01';
        const lastDay   = new Date(d.getFullYear(), d.getMonth() + 1, 0);
        endDate         = lastDay.toISOString().slice(0, 10);
        break;
      }

      case 'semester': {
        const month = d.getMonth() + 1;
        if (month >= 3 && month <= 7) {
          startDate = d.getFullYear() + '-03-01';
          endDate   = d.getFullYear() + '-07-31';
        } else {
          startDate = d.getFullYear() + '-08-01';
          endDate   = d.getFullYear() + '-12-31';
        }
        break;
      }

      case 'yearly':
        startDate = d.getFullYear() + '-01-01';
        endDate   = d.getFullYear() + '-12-31';
        break;

      default:
        startDate = endDate = dateValue;
    }

    return { startDate, endDate };
  }

};
