const API = {

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
    sessionStorage.removeItem('sessionProg');
    sessionStorage.removeItem('sessionExpiry');
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
    return { isValid, role: sessionStorage.getItem('sessionRole') };
  },

  async updatePassword(roleOrProgName, newPwd) {
    await SUPABASE.update('settings',
      { password: newPwd },
      `?role=eq.${encodeURIComponent(roleOrProgName)}`
    );
    return true;
  },

  async getPasswordList() {
    const data = await SUPABASE.select('settings', '?select=role,password&order=role');
    return data.map(d => ({ role: d.role, pwd: d.password }));
  },

  // ==========================================
  // 🔄 초기 로딩
  // ==========================================

  async getInitialData() {
    const students = await SUPABASE.select('students', '?select=grade,class_num,day,period,program');

    // 프로그램 구조 생성
    const programStructure = {};
    students.forEach(s => {
      if (!s.program || !s.day || !s.period) return;
      const day = s.day.replace('요일', '');
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

    // 학년별 정렬
    Object.keys(homeroomStructure).forEach(g => {
      homeroomStructure[g].sort((a, b) => a - b);
    });

    return { programStructure, homeroomStructure };
  },

  // ==========================================
  // 🔵 강사
  // ==========================================

  async getInstDashboardData(progName, targetDay, targetPeriod, selectedDate) {
    const day = targetDay.replace('요일', '');

    // 학생 목록
    const students = await SUPABASE.select('students',
      `?program=eq.${encodeURIComponent(progName)}&day=eq.${encodeURIComponent(targetDay)}&period=eq.${encodeURIComponent(targetPeriod)}`
    );

    // 기존 출결 기록
    const existingArr = await SUPABASE.select('attendance',
      `?date=eq.${selectedDate}&program=eq.${encodeURIComponent(progName)}&period=eq.${encodeURIComponent(targetPeriod)}`
    );
    const existing = {};
    existingArr.forEach(r => {
      existing[`${r.grade}_${r.class_num}_${r.name}`] = { status: r.status, reason: r.reason || '' };
    });

    // 오늘 담임 메모
    const memos = await SUPABASE.select('pre_memos',
      `?date=eq.${selectedDate}`
    );
    const memoMap = {};
    memos.forEach(m => {
      if (m.name !== '__공지__') {
        memoMap[`${m.grade}_${m.class_num}_${m.name}`] = `${m.status}|${m.reason || ''}`;
      }
    });

    // 공지사항
    const noticeMap = {};
    memos.filter(m => m.name === '__공지__').forEach(m => {
      noticeMap[`${m.grade}_${m.class_num}`] = m.status;
    });

    // 연락처
    const contacts = await SUPABASE.select('contacts', '?select=grade,class_num,name,phone');
    const contactMap = {};
    contacts.forEach(c => { contactMap[`${c.grade}_${c.class_num}_${c.name}`] = c.phone || ''; });

    // 활동일지
    const actLogs = await SUPABASE.select('activity_logs',
      `?date=eq.${selectedDate}&program=eq.${encodeURIComponent(progName)}`
    );
    const activityContent = actLogs.length > 0 ? actLogs[0].content : '';

    const seen = {};
    const result = [];
    students.forEach(s => {
      const key = `${s.grade}_${s.class_num}_${s.name}`;
      if (seen[key]) return;
      seen[key] = true;
      result.push({
        grade: s.grade,
        classNum: s.class_num,
        name: s.name,
        permNote: s.perm_note || '',
        dailyNote: memoMap[key] || '',
        attendanceRate: 100,
        contact: contactMap[key] || '',
        classNotice: noticeMap[`${s.grade}_${s.class_num}`] || ''
      });
    });

    result.sort((a, b) => {
      if (a.grade !== b.grade) return a.grade - b.grade;
      if (a.classNum !== b.classNum) return a.classNum - b.classNum;
      return a.name.localeCompare(b.name, 'ko-KR');
    });

    return { students: result, existing, activityContent };
  },

  async saveAttendanceData(selectedDate, progName, day, period, attendanceList, isCanceled, substituteInstructor) {
    // 기존 기록 삭제
    await SUPABASE.delete('attendance',
      `?date=eq.${selectedDate}&program=eq.${encodeURIComponent(progName)}&period=eq.${encodeURIComponent(period)}`
    );

    const instructor = await this._getInstructor(progName);
    const recorder = substituteInstructor ? `${substituteInstructor}(대체강사)` : instructor;
    const month = `${new Date(selectedDate).getMonth() + 1}월`;
    const now = new Date().toTimeString().slice(0, 8);

    if (isCanceled) {
      await SUPABASE.insert('attendance', [{
        date: selectedDate, check_time: now, day, period,
        program: progName, grade: null, class_num: null,
        name: '전체', status: '휴강', month, reason: '', recorder
      }]);
    } else {
      const rows = attendanceList.map(s => ({
        date: selectedDate, check_time: now, day, period,
        program: progName, grade: s.grade, class_num: s.classNum,
        name: s.name, status: s.status, month, reason: s.reason || '', recorder
      }));
      if (rows.length > 0) await SUPABASE.insert('attendance', rows);
    }

    // 제출현황 업데이트
    await this._updateSubmission(selectedDate, progName, period, day,
      isCanceled ? '🚫 휴강' : '✅ 제출 완료', null, recorder
    );

    // 소급입력 체크
    const today = new Date().toISOString().slice(0, 10);
    const isLate = selectedDate < today;

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
        if (s.status === '출석') summary.present++;
        else if (s.status === '결석') summary.absent++;
        else if (s.status === '지각') summary.late++;
        else if (s.status === '조퇴') summary.leave++;
      });
    }

    return { success: true, alerts, summary };
  },

  async saveActivityLog(selectedDate, progName, day, periods, activityContent, substituteInstructor) {
    const periodList = String(periods).split(',');
    const firstPeriod = periodList[0].trim();
    const lastPeriod = periodList[periodList.length - 1].trim();
    const PERIOD_TIME = {
      '5교시': { start: '13:10', end: '13:50' },
      '6교시': { start: '14:00', end: '14:40' },
      '7교시': { start: '14:50', end: '15:30' },
      '8교시': { start: '15:40', end: '16:20' }
    };
    const startTime = PERIOD_TIME[firstPeriod]?.start || '';
    const endTime = PERIOD_TIME[lastPeriod]?.end || '';
    const instructor = await this._getInstructor(progName);
    const recorder = substituteInstructor ? substituteInstructor : instructor;
    const remark = substituteInstructor ? `${substituteInstructor}(대체)` : '';
    const month = `${new Date(selectedDate).getMonth() + 1}월`;
    const dateObj = new Date(selectedDate + 'T00:00:00');
    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    const dayOfWeek = dayNames[dateObj.getDay()];
    const periodText = periodList.length === 1 ? firstPeriod : `${firstPeriod}-${lastPeriod}`;

    // 기존 기록 확인
    const existing = await SUPABASE.select('activity_logs',
      `?date=eq.${selectedDate}&program=eq.${encodeURIComponent(progName)}`
    );

    const rowData = {
      date: selectedDate, day: dayOfWeek, program: progName,
      instructor: recorder, period: periodText,
      start_time: startTime, end_time: endTime,
      content: activityContent, remark, month
    };

    if (existing.length > 0) {
      await SUPABASE.update('activity_logs', rowData,
        `?date=eq.${selectedDate}&program=eq.${encodeURIComponent(progName)}`
      );
    } else {
      await SUPABASE.insert('activity_logs', [rowData]);
    }

    // 제출현황 업데이트
    // 활동일지는 출결과 같은 date + program + period 행에 반영되어야 합니다.
    // 기존처럼 period/day를 null로 넘기면 day/period가 빈 submissions 행이 새로 생겨
    // 미제출 현황이 잘못 계산됩니다.
    for (const p of periodList) {
      const targetPeriod = p.trim();
      if (!targetPeriod) continue;

      await this._updateSubmission(
        selectedDate,
        progName,
        targetPeriod,
        dayOfWeek,
        null,
        '✅ 제출 완료',
        recorder
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
      result[`${r.grade}_${r.class_num}_${r.name}`] = { status: r.status, reason: r.reason || '' };
    });
    return result;
  },

  // ==========================================
  // 🟢 담임
  // ==========================================

  async getHomeroomStudents(grade, classNum, targetDate) {
    const students = await SUPABASE.select('students',
      `?grade=eq.${grade}&class_num=eq.${classNum}&select=name`
    );
    const uniqueNames = [...new Set(students.map(s => s.name))];

    const memos = await SUPABASE.select('pre_memos',
      `?date=eq.${targetDate}&grade=eq.${grade}&class_num=eq.${classNum}`
    );
    const memoMap = {};
    memos.forEach(m => {
      if (m.name !== '__공지__') {
        memoMap[m.name] = `${m.status}|${m.reason || ''}`;
      }
    });

    return uniqueNames.sort((a, b) => a.localeCompare(b, 'ko-KR')).map(name => ({
      name, dailyNote: memoMap[name] || ''
    }));
  },

  async saveHomeroomMemos(grade, classNum, memoData, targetDate) {
    // 기존 삭제
    await SUPABASE.delete('pre_memos',
      `?date=eq.${targetDate}&grade=eq.${grade}&class_num=eq.${classNum}&name=neq.__공지__`
    );

    // 새 메모 삽입
    const rows = memoData
      .filter(m => m.note && m.note.trim() !== '')
      .map(m => {
        const parts = m.note.split('|');
        return {
          date: targetDate, grade: parseInt(grade), class_num: parseInt(classNum),
          name: m.name, status: parts[0]?.trim() || '', reason: parts[1]?.trim() || ''
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
      prog: r.program, period: r.period,
      name: r.name, status: r.status, reason: r.reason || ''
    }));
  },

  async getHomeroomAttendance(grade, classNum, month) {
    const data = await SUPABASE.select('attendance',
      `?grade=eq.${grade}&class_num=eq.${classNum}&month=eq.${encodeURIComponent(month)}&status=neq.휴강`
    );

    const studentStats = {};
    data.forEach(r => {
      if (!studentStats[r.name]) {
        studentStats[r.name] = { present: 0, absent: 0, late: 0, leave: 0, total: 0, programs: {} };
      }
      studentStats[r.name].total++;
      if (r.status === '출석') studentStats[r.name].present++;
      else if (r.status === '결석') studentStats[r.name].absent++;
      else if (r.status === '지각') studentStats[r.name].late++;
      else if (r.status === '조퇴') studentStats[r.name].leave++;
    });

    const studentList = Object.keys(studentStats).sort((a, b) => a.localeCompare(b, 'ko-KR')).map(name => {
      const s = studentStats[name];
      return {
        name, present: s.present, absent: s.absent, late: s.late, leave: s.leave,
        total: s.total, rate: s.total > 0 ? Math.round((s.present / s.total) * 100) : 0
      };
    });

    return { records: data, studentList };
  },

  async saveClassNotice(grade, classNum, notice) {
    const today = new Date().toISOString().slice(0, 10);
    await SUPABASE.delete('pre_memos',
      `?date=eq.${today}&grade=eq.${grade}&class_num=eq.${classNum}&name=eq.__공지__`
    );
    if (notice && notice.trim()) {
      await SUPABASE.insert('pre_memos', [{
        date: today, grade: parseInt(grade), class_num: parseInt(classNum),
        name: '__공지__', status: notice.trim(), reason: ''
      }]);
    }
    return { success: true };
  },

  async getClassNotice(grade, classNum) {
    const today = new Date().toISOString().slice(0, 10);
    const data = await SUPABASE.select('pre_memos',
      `?date=eq.${today}&grade=eq.${grade}&class_num=eq.${classNum}&name=eq.__공지__`
    );
    return data.length > 0 ? data[0].status : '';
  },

  // ==========================================
  // 🟣 관리자
  // ==========================================

  async getAdminAllData(targetDate, periodType) {
    const dateRange = this._getDateRange(periodType, targetDate);

    const [allAttendance, submissions] = await Promise.all([
      SUPABASE.select('attendance',
        `?date=gte.${dateRange.startDate}&date=lte.${dateRange.endDate}`
      ),
      SUPABASE.select('submissions',
        `?date=gte.${dateRange.startDate}&date=lte.${dateRange.endDate}`
      )
    ]);

    // daily 통계
    const dailyData = allAttendance.filter(r => r.date === targetDate);
    const progStats = {};
    dailyData.forEach(r => {
      if (!progStats[r.program]) progStats[r.program] = { total: 0, present: 0, absent: 0, late: 0, leave: 0 };
      progStats[r.program].total++;
      if (r.status === '출석') progStats[r.program].present++;
      else if (r.status === '결석') progStats[r.program].absent++;
      else if (r.status === '지각') progStats[r.program].late++;
      else if (r.status === '조퇴') progStats[r.program].leave++;
    });

    const daily = {
      present: dailyData.filter(r => r.status === '출석').length,
      absent: dailyData.filter(r => r.status === '결석').length,
      late: dailyData.filter(r => r.status === '지각').length,
      leave: dailyData.filter(r => r.status === '조퇴').length,
      canceled: dailyData.filter(r => r.status === '휴강').length,
      progStats,
      records: dailyData.map(r => ({
        _id: r.id,
        recordKey: {
          id: r.id,
          date: r.date,
          prog: r.program,
          period: r.period,
          grade: String(r.grade),
          classNum: String(r.class_num),
          name: r.name
        },
        date: r.date, prog: r.program, period: r.period,
        grade: r.grade, classNum: r.class_num, name: r.name,
        status: r.status, reason: r.reason || '', recorder: r.recorder || ''
      }))
    };

    // multi 통계
    const filteredRecords = allAttendance.filter(r => r.status !== '휴강');
    const multiProgStats = {};
    const datesByProg = {};
    const studentStatsMap = {};
    const totalStats = { present: 0, absent: 0, late: 0, leave: 0, canceled: 0 };

    allAttendance.forEach(r => {
      if (r.status === '휴강') { totalStats.canceled++; return; }
      if (!multiProgStats[r.program]) multiProgStats[r.program] = { present: 0, absent: 0, late: 0, leave: 0, canceled: 0 };
      if (!datesByProg[r.program]) datesByProg[r.program] = {};
      datesByProg[r.program][r.date] = true;
      if (r.status === '출석') { multiProgStats[r.program].present++; totalStats.present++; }
      else if (r.status === '결석') { multiProgStats[r.program].absent++; totalStats.absent++; }
      else if (r.status === '지각') { multiProgStats[r.program].late++; totalStats.late++; }
      else if (r.status === '조퇴') { multiProgStats[r.program].leave++; totalStats.leave++; }
    });

    Object.keys(datesByProg).forEach(prog => {
      multiProgStats[prog].classDays = Object.keys(datesByProg[prog]).length;
    });

    filteredRecords.forEach(r => {
      const key = `${r.grade}_${r.class_num}_${r.name}_${r.program}`;
      if (!studentStatsMap[key]) {
        studentStatsMap[key] = { grade: r.grade, classNum: r.class_num, name: r.name, prog: r.program, present: 0, absent: 0, late: 0, leave: 0, total: 0 };
      }
      studentStatsMap[key].total++;
      if (r.status === '출석') studentStatsMap[key].present++;
      else if (r.status === '결석') studentStatsMap[key].absent++;
      else if (r.status === '지각') studentStatsMap[key].late++;
      else if (r.status === '조퇴') studentStatsMap[key].leave++;
    });

    const studentList = Object.values(studentStatsMap).map(s => ({
      ...s, rate: s.total > 0 ? Math.round((s.present / s.total) * 100) : 0
    })).sort((a, b) => a.rate - b.rate);

    const multi = {
      periodType, startDate: dateRange.startDate, endDate: dateRange.endDate,
      totalStats, progStats: multiProgStats, studentList,
      absentStudents: [], sheet3: [], sheet4: []
    };

    // 제출현황
    const submit = await this._buildSubmitData(submissions, dateRange);

    return { daily, multi, submit, lateSubmitCount: submit.lateSubmitCount || 0 };
  },

  async getRecordsByPeriod(targetDate, periodType) {
    const dateRange = this._getDateRange(periodType, targetDate);
    const data = await SUPABASE.select('attendance',
      `?date=gte.${dateRange.startDate}&date=lte.${dateRange.endDate}`
    );
    const records = data.map(r => ({
      _id: r.id,
      recordKey: {
        id: r.id,
        date: r.date,
        prog: r.program,
        period: r.period,
        grade: String(r.grade),
        classNum: String(r.class_num),
        name: r.name
      },
      date: r.date, prog: r.program, period: r.period,
      grade: r.grade, classNum: r.class_num, name: r.name,
      status: r.status, reason: r.reason || '', recorder: r.recorder || ''
    }));
    return { records, startDate: dateRange.startDate, endDate: dateRange.endDate };
  },

  async updateAdminRecord(recordKey, newStatus, newReason) {
    if (!recordKey || !recordKey.id) {
      throw new Error('수정 대상 id가 없습니다. 새로고침 후 다시 시도해주세요.');
    }

    const updated = await SUPABASE.update(
      'attendance',
      { status: newStatus, reason: newReason },
      `?id=eq.${recordKey.id}`
    );

    return Array.isArray(updated) && updated.length > 0;
  },

  async getSubmissionStatus(targetDate, periodType) {
    const dateRange = this._getDateRange(periodType, targetDate);
    const submissions = await SUPABASE.select('submissions',
      `?date=gte.${dateRange.startDate}&date=lte.${dateRange.endDate}`
    );
    return this._buildSubmitData(submissions, dateRange);
  },

  async generateAbsentMessages(targetDate, periodType) {
    const dateRange = this._getDateRange(periodType, targetDate);

    const allRecords = await SUPABASE.select('attendance',
      `?date=gte.${dateRange.startDate}&date=lte.${dateRange.endDate}&status=neq.휴강`
    );

    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    const statsByStudentProgram = {};

    allRecords.forEach(r => {
      const key = `${r.grade}_${r.class_num}_${r.name}_${r.program}`;
      if (!statsByStudentProgram[key]) {
        statsByStudentProgram[key] = {
          grade: r.grade,
          classNum: r.class_num,
          name: r.name,
          prog: r.program,
          present: 0,
          absent: 0,
          late: 0,
          leave: 0,
          total: 0,
          absences: []
        };
      }

      const stat = statsByStudentProgram[key];
      stat.total++;

      if (r.status === '출석') stat.present++;
      else if (r.status === '결석') {
        stat.absent++;
        const dateObj = new Date(r.date + 'T00:00:00');
        stat.absences.push({
          date: r.date,
          day: dayNames[dateObj.getDay()],
          dateDisplay: `${parseInt(r.date.split('-')[1])}/${parseInt(r.date.split('-')[2])}(${dayNames[dateObj.getDay()]})`,
          prog: r.program,
          period: r.period,
          reason: r.reason || '사유 미등록'
        });
      }
      else if (r.status === '지각') stat.late++;
      else if (r.status === '조퇴') stat.leave++;
    });

    function getAbsenceGuide(absentCount) {
      if (absentCount >= 5) return '지속적인 결석이 누적되고 있어 보호자 상담 및 출결 관리가 필요합니다.';
      if (absentCount === 4) return '결석이 4회 누적되었습니다. 반복 결석 원인 확인과 상담을 권장드립니다.';
      if (absentCount === 3) return '결석이 3회 누적되었습니다. 이후 출결에 각별한 관심 부탁드립니다.';
      if (absentCount === 2) return '결석이 반복되고 있습니다. 다음 수업 참여 여부를 확인해주세요.';
      return '결석 사실을 안내드립니다. 다음 수업 참여 여부를 확인해주세요.';
    }

    const isDaily = !periodType || periodType === 'daily';
    const messages = [];
    const absentStats = Object.values(statsByStudentProgram)
      .filter(s => s.absent > 0)
      .sort((a, b) => {
        if (a.grade !== b.grade) return a.grade - b.grade;
        if (a.classNum !== b.classNum) return a.classNum - b.classNum;
        return String(a.name).localeCompare(String(b.name), 'ko-KR');
      });

    absentStats.forEach(s => {
      const rate = s.total > 0 ? Math.round((s.present / s.total) * 100) : 0;
      const guide = getAbsenceGuide(s.absent);

      if (isDaily) {
        s.absences.forEach(a => {
          let msg = '[순창초 방과후학교 안내]\n학부모님 안녕하세요.\n';
          msg += `${s.grade}학년 ${s.classNum}반 ${s.name} 학생이 [${a.prog}] 수업(${a.day}요일 ${a.period})에 결석하였습니다.\n`;
          msg += `• 사유: ${a.reason}\n`;
          msg += `• 누적 결석: ${s.absent}회\n`;
          msg += `• 현재 출석률: ${rate}%\n`;
          msg += `• 안내: ${guide}\n`;
          msg += '\n문의: 순창초 늘봄지원실';
          messages.push({ name: `${s.grade}-${s.classNum} ${s.name}`, prog: a.prog, message: msg });
        });
      } else {
        let msg = '[순창초 방과후학교 안내]\n학부모님 안녕하세요.\n';
        s.absences.forEach(a => { msg += `• ${a.dateDisplay} [${a.prog}] ${a.period} - ${a.reason}\n`; });
        msg += `\n• 결석: ${s.absent}회\n`;
        msg += `• 출석률: ${rate}%\n`;
        msg += `• 안내: ${guide}\n`;
        msg += '\n문의: 순창초 늘봄지원실';
        messages.push({ name: `${s.grade}-${s.classNum} ${s.name}`, prog: s.prog, message: msg });
      }
    });

    const studentCount = new Set(absentStats.map(s => `${s.grade}_${s.classNum}_${s.name}`)).size;
    let summaryMsg = '';
    if (absentStats.length > 0) {
      summaryMsg = `[결석 현황 요약]\n총 ${studentCount}명 결석\n\n`;
      absentStats.forEach((s, i) => {
        const rate = s.total > 0 ? Math.round((s.present / s.total) * 100) : 0;
        summaryMsg += `${i + 1}. ${s.grade}-${s.classNum} ${s.name} | ${s.prog} | 결석 ${s.absent}회 | 출석률 ${rate}%\n`;
      });
    }

    return {
      individual: messages,
      summary: summaryMsg,
      count: messages.length,
      studentCount,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate
    };
  },

  // ==========================================
  // 📄 서류 (PDF — 추후 구현)
  // ==========================================

  async getAttendanceDocList() {
    const data = await SUPABASE.select(
      'doc_history',
      '?select=month,doc_type,created_at,updated_at,status&order=month.desc,doc_type.asc'
    );
    return data.map(d => ({
      month:     d.month,
      docType:   d.doc_type,
      url:       '',
      createdAt: d.created_at || '-',
      updatedAt: d.updated_at || '-',
      status:    d.status || '작업중'
    }));
  },

  async generateAttendanceDoc(month, targetProg) {
    await generateAttendancePDF(month, targetProg || '전체');

    // 생성 기록 저장
    const now = new Date().toLocaleString('ko-KR');
    const existing = await SUPABASE.select(
      'doc_history',
      `?month=eq.${encodeURIComponent(month)}&doc_type=eq.출석부`
    );

    if (existing.length > 0) {
      await SUPABASE.update(
        'doc_history',
        { updated_at: now, status: '작업중' },
        `?month=eq.${encodeURIComponent(month)}&doc_type=eq.출석부`
      );
    } else {
      await SUPABASE.insert('doc_history', [{
        month:      month,
        doc_type:   '출석부',
        created_at: now,
        updated_at: now,
        status:     '작업중'
      }]);
    }

    return { success: true, url: '', isUpdate: existing.length > 0 };
  },

  async generateActivityDoc(month, targetProg) {
    await generateActivityPDF(month, targetProg || '전체');

    // 생성 기록 저장
    const now = new Date().toLocaleString('ko-KR');
    const existing = await SUPABASE.select(
      'doc_history',
      `?month=eq.${encodeURIComponent(month)}&doc_type=eq.활동일지`
    );

    if (existing.length > 0) {
      await SUPABASE.update(
        'doc_history',
        { updated_at: now, status: '작업중' },
        `?month=eq.${encodeURIComponent(month)}&doc_type=eq.활동일지`
      );
    } else {
      await SUPABASE.insert('doc_history', [{
        month:      month,
        doc_type:   '활동일지',
        created_at: now,
        updated_at: now,
        status:     '작업중'
      }]);
    }

    return { success: true, url: '', isUpdate: existing.length > 0 };
  },
  async finalizeMonth(month, docType) {
    const now = new Date().toLocaleString('ko-KR');
    const existing = await SUPABASE.select(
      'doc_history',
      `?month=eq.${encodeURIComponent(month)}&doc_type=eq.${encodeURIComponent(docType)}`
    );

    if (!existing || existing.length === 0) {
      return { success: false, message: `${month} ${docType} 문서 기록이 없습니다.` };
    }

    const currentStatus = existing[0].status || '작업중';
    const nextStatus = currentStatus === '확정' ? '작업중' : '확정';

    const updated = await SUPABASE.update(
      'doc_history',
      { status: nextStatus, updated_at: now },
      `?month=eq.${encodeURIComponent(month)}&doc_type=eq.${encodeURIComponent(docType)}`
    );

    if (!Array.isArray(updated) || updated.length === 0) {
      return { success: false, message: '상태 변경 대상 문서를 찾지 못했습니다.' };
    }

    return {
      success: true,
      status: nextStatus,
      message: nextStatus === '확정'
        ? `${month} ${docType} 월 마감 완료`
        : `${month} ${docType} 마감 해지 완료`
    };
  },

  async setMonthFinalized(month, shouldFinalize) {
    const now = new Date().toLocaleString('ko-KR');
    const requiredDocTypes = ['출석부', '활동일지'];

    const existing = await SUPABASE.select(
      'doc_history',
      `?month=eq.${encodeURIComponent(month)}&select=id,month,doc_type,status`
    );

    const existingTypes = new Set((existing || []).map(d => d.doc_type));
    const missingTypes = requiredDocTypes.filter(t => !existingTypes.has(t));

    if (missingTypes.length > 0) {
      return {
        success: false,
        message: `${month} ${missingTypes.join(', ')} 문서가 없습니다. 먼저 출석부와 활동일지를 모두 생성/갱신하세요.`
      };
    }

    const nextStatus = shouldFinalize ? '확정' : '작업중';
    const updatedRows = [];

    for (const docType of requiredDocTypes) {
      const updated = await SUPABASE.update(
        'doc_history',
        { status: nextStatus, updated_at: now },
        `?month=eq.${encodeURIComponent(month)}&doc_type=eq.${encodeURIComponent(docType)}`
      );

      if (Array.isArray(updated)) updatedRows.push(...updated);
    }

    if (updatedRows.length < requiredDocTypes.length) {
      return {
        success: false,
        message: '월 마감 상태 변경 중 일부 문서를 찾지 못했습니다. 새로고침 후 다시 시도하세요.'
      };
    }

    return {
      success: true,
      status: nextStatus,
      message: shouldFinalize
        ? `${month} 월 마감 완료`
        : `${month} 월 마감 해지 완료`
    };
  },

  // ==========================================
  // 👤 학생관리
  // ==========================================

  async getAdminStudentList(grade, classNum, targetDate) {
    let params = '?select=grade,class_num,name,perm_note';
    if (grade !== '전체') params += `&grade=eq.${grade}`;
    if (classNum !== '전체') params += `&class_num=eq.${classNum}`;

    const studentsRaw = await SUPABASE.select('students', params);
    const seen = {};
    const students = [];
    studentsRaw.forEach(s => {
      const key = `${s.grade}_${s.class_num}_${s.name}`;
      if (!seen[key]) {
        seen[key] = true;
        students.push(s);
      }
    });

    const memos = await SUPABASE.select('pre_memos',
      `?date=eq.${targetDate}${grade !== '전체' ? `&grade=eq.${grade}` : ''}${classNum !== '전체' ? `&class_num=eq.${classNum}` : ''}&name=neq.__공지__`
    );
    const memoMap = {};
    memos.forEach(m => {
      memoMap[`${m.grade}_${m.class_num}_${m.name}`] = `${m.status}|${m.reason || ''}`;
    });

    return students.sort((a, b) => {
      if (a.grade !== b.grade) return a.grade - b.grade;
      if (a.class_num !== b.class_num) return a.class_num - b.class_num;
      return a.name.localeCompare(b.name, 'ko-KR');
    }).map(s => ({
      grade: s.grade, classNum: s.class_num, name: s.name,
      permNote: s.perm_note || '',
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
      rowIndex: idx,
      date: item.date, day: item.day, prog: item.program,
      instructor: item.instructor, period: item.period,
      startTime: item.start_time, endTime: item.end_time,
      content: item.content || '', remark: item.remark || '',
      _id: item.id
    }));
  },

  async updateActivityLog(rowIndex, newContent) {
    // rowIndex가 실제 Supabase id인 경우 처리
    if (!rowIndex) return false;

    // rowIndex가 숫자면 배열 인덱스, 문자면 uuid로 처리
    if (typeof rowIndex === 'string' && rowIndex.includes('-')) {
      // uuid 방식
      await SUPABASE.update(
        'activity_logs',
        { content: newContent },
        `?id=eq.${rowIndex}`
      );
    } else {
      // 배열 인덱스 방식 — activityLogData는 index.html에 있으므로
      // api.js에서 직접 접근 불가 → id를 직접 받도록 변경
      await SUPABASE.update(
        'activity_logs',
        { content: newContent },
        `?id=eq.${rowIndex}`
      );
    }
    return true;
  },

  async getInstMissingList(progName, month) {
    const data = await SUPABASE.select('submissions',
      `?program=eq.${encodeURIComponent(progName)}&month=eq.${encodeURIComponent(month)}`
    );
    const today = new Date().toISOString().slice(0, 10);

    function cleanSt(val) {
      return String(val).replace(/\s/g, '').replace(/[^\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/g, '');
    }

    return data
      .filter(item => {
        if (item.date > today) return false;
        const attendDone = cleanSt(item.attend_status).includes('제출완료') || cleanSt(item.attend_status).includes('휴강');
        const actDone = cleanSt(item.activity_status).includes('제출완료') || cleanSt(item.activity_status).includes('휴강');
        return !(attendDone && actDone);
      })
      .map(item => {
        const attendDone = cleanSt(item.attend_status).includes('제출완료') || cleanSt(item.attend_status).includes('휴강');
        const actDone = cleanSt(item.activity_status).includes('제출완료') || cleanSt(item.activity_status).includes('휴강');
        return {
          date: item.date, day: item.day, period: item.period,
          prog: item.program, instructor: item.instructor,
          attendDone, activityDone: actDone
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  },

  // ==========================================
  // 🔧 내부 헬퍼 함수
  // ==========================================

  async _getInstructor(progName) {
    const data = await SUPABASE.select('instructors',
      `?program=eq.${encodeURIComponent(progName)}&select=instructor_name`
    );
    return data.length > 0 ? data[0].instructor_name : '';
  },

async _updateSubmission(date, program, period, day, attendStatus, activityStatus, instructor) {
  const clean = function(value) {
    return String(value || '').trim();
  };

  const targetDate = clean(date);
  const targetProgram = clean(program);
  const targetPeriod = clean(period);
  const targetDay = clean(day);
  const targetInstructor = clean(instructor);

  if (!targetDate || !targetProgram || !targetPeriod) {
    throw new Error('제출현황 업데이트 실패: 날짜, 프로그램, 교시가 필요합니다.');
  }

  const today = new Date().toISOString().slice(0, 10);
  const isLate = targetDate < today;
  const month = `${new Date(targetDate + 'T00:00:00').getMonth() + 1}월`;
  const nowTime = new Date().toTimeString().slice(0, 8);
  const lateTime = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const params =
    `?date=eq.${targetDate}` +
    `&program=eq.${encodeURIComponent(targetProgram)}` +
    `&period=eq.${encodeURIComponent(targetPeriod)}`;

  const existing = await SUPABASE.select('submissions', params + '&select=*');

  if (existing && existing.length > 0) {
    const keep = existing[0];

    const updateData = {
      day: targetDay || keep.day || '',
      period: targetPeriod,
      program: targetProgram,
      month: month,
      submit_time: nowTime
    };

    if (targetInstructor) {
      updateData.instructor = targetInstructor;
    }

    if (attendStatus) {
      updateData.attend_status = attendStatus;
    }

    if (activityStatus) {
      updateData.activity_status = activityStatus;
    }

    if (isLate) {
      updateData.late_submit = '✅ 소급입력';
      updateData.late_submit_time = lateTime;
    }

    await SUPABASE.update(
      'submissions',
      updateData,
      `?id=eq.${keep.id}`
    );

    // 혹시 예전에 생긴 중복 행이 있으면 첫 번째만 남기고 삭제
    if (existing.length > 1) {
      const deleteIds = existing.slice(1).map(function(row) {
        return row.id;
      }).filter(Boolean);

      if (deleteIds.length > 0) {
        await SUPABASE.delete(
          'submissions',
          `?id=in.(${deleteIds.join(',')})`
        );
      }
    }

    return true;
  }

  const insertRow = {
    date: targetDate,
    day: targetDay,
    period: targetPeriod,
    program: targetProgram,
    instructor: targetInstructor,
    attend_status: attendStatus || '❌ 미제출',
    activity_status: activityStatus || '❌ 미제출',
    submit_time: nowTime,
    month: month,
    late_submit: isLate ? '✅ 소급입력' : '',
    late_submit_time: isLate ? lateTime : ''
  };

  try {
    await SUPABASE.insert('submissions', [insertRow]);
    return true;
  } catch (err) {
    // unique index 때문에 동시에 insert가 막힌 경우, 다시 조회 후 update
    const retry = await SUPABASE.select('submissions', params + '&select=*');

    if (retry && retry.length > 0) {
      const retryUpdate = {
        day: targetDay || retry[0].day || '',
        period: targetPeriod,
        program: targetProgram,
        month: month,
        submit_time: nowTime
      };

      if (targetInstructor) {
        retryUpdate.instructor = targetInstructor;
      }

      if (attendStatus) {
        retryUpdate.attend_status = attendStatus;
      }

      if (activityStatus) {
        retryUpdate.activity_status = activityStatus;
      }

      if (isLate) {
        retryUpdate.late_submit = '✅ 소급입력';
        retryUpdate.late_submit_time = lateTime;
      }

      await SUPABASE.update(
        'submissions',
        retryUpdate,
        `?id=eq.${retry[0].id}`
      );

      return true;
    }

    throw err;
  }
},

  async _buildSubmitData(submissions, dateRange) {
    function cleanSt(val) {
      return String(val).replace(/\s/g, '').replace(/[^\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/g, '');
    }

    const submitted = [];
    const notSubmitted = [];
    const lateSubmits = [];

    submissions.forEach(item => {
      const attendClean = cleanSt(item.attend_status);
      const activityClean = cleanSt(item.activity_status);
      const attendDone = attendClean.includes('제출완료') || attendClean.includes('휴강');
      const actDone = activityClean.includes('제출완료') || activityClean.includes('휴강');

      const obj = {
        date: item.date, day: item.day, period: item.period,
        prog: item.program, instructor: item.instructor || '',
        attendStatus: item.attend_status, activityStatus: item.activity_status,
        submitTime: item.submit_time || '',
        lateSubmit: item.late_submit || '',
        lateSubmitTime: item.late_submit_time || ''
      };

      if (attendDone && actDone) submitted.push(obj);
      else notSubmitted.push(obj);

      if (item.late_submit === '✅ 소급입력') lateSubmits.push(obj);
    });

    submitted.sort((a, b) => a.date.localeCompare(b.date) || a.period.localeCompare(b.period));
    notSubmitted.sort((a, b) => a.date.localeCompare(b.date) || a.period.localeCompare(b.period));
    lateSubmits.sort((a, b) => b.date.localeCompare(a.date));

    // 기간 밖 미제출
    const historyRecords = [];

    return {
      total: submitted.length + notSubmitted.length,
      submittedCount: submitted.length,
      notSubmittedCount: notSubmitted.length,
      submitted, notSubmitted,
      history: historyRecords,
      lateSubmits, lateSubmitCount: lateSubmits.length,
      startDate: dateRange.startDate, endDate: dateRange.endDate
    };
  },

  _getDateRange(periodType, dateValue) {
    const d = new Date(dateValue + 'T00:00:00');
    let startDate, endDate;
    switch (periodType) {
      case 'daily':
        startDate = endDate = dateValue; break;
      case 'weekly':
        const dow = d.getDay();
        const mondayOffset = dow === 0 ? -6 : 1 - dow;
        const monday = new Date(d); monday.setDate(d.getDate() + mondayOffset);
        const friday = new Date(monday); friday.setDate(monday.getDate() + 4);
        startDate = monday.toISOString().slice(0, 10);
        endDate = friday.toISOString().slice(0, 10);
        break;
      case 'monthly':
        startDate = dateValue.slice(0, 7) + '-01';
        const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
        endDate = lastDay.toISOString().slice(0, 10);
        break;
      case 'semester':
        const month = d.getMonth() + 1;
        if (month >= 3 && month <= 7) {
          startDate = d.getFullYear() + '-03-01';
          endDate = d.getFullYear() + '-07-31';
        } else {
          startDate = d.getFullYear() + '-08-01';
          endDate = d.getFullYear() + '-12-31';
        }
        break;
      case 'yearly':
        startDate = d.getFullYear() + '-01-01';
        endDate = d.getFullYear() + '-12-31';
        break;
      default:
        startDate = endDate = dateValue;
    }
    return { startDate, endDate };
  }
};
