import { useState, useEffect, useCallback, useRef } from "react";

// Polyfill for window.storage if not present (standard browser environment)
if (!window.storage) {
  window.storage = {
    get: (key) => {
      try {
        const value = localStorage.getItem(key);
        return Promise.resolve({ value });
      } catch (e) {
        return Promise.resolve({ value: null });
      }
    },
    set: (key, value) => {
      try {
        localStorage.setItem(key, value);
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    }
  };
}

const STORAGE_KEY = "task-shift-tracker";

const generateId = () => Math.random().toString(36).substr(2, 9);

const formatDate = (ts) => {
  const d = new Date(ts);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
};
const formatDateTime = (ts) => {
  const d = new Date(ts);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};
const formatTime = (ts) => {
  const d = new Date(ts);
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
};

const timeSince = (ts) => {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}min`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
};

// Calculate milliseconds of overlap with business hours (Mon-Fri 8:00-18:00)
const calcBusinessMs = (startTs, endTs) => {
  if (!startTs || !endTs || startTs >= endTs) return 0;
  const WORK_START_H = 8;
  const WORK_END_H = 18;
  let total = 0;
  let cursor = new Date(startTs);
  const end = new Date(endTs);

  // Walk day by day
  while (cursor < end) {
    const dow = cursor.getDay();
    if (dow >= 1 && dow <= 5) {
      const dayWorkStart = new Date(cursor);
      dayWorkStart.setHours(WORK_START_H, 0, 0, 0);
      const dayWorkEnd = new Date(cursor);
      dayWorkEnd.setHours(WORK_END_H, 0, 0, 0);

      const overlapStart = Math.max(cursor.getTime(), dayWorkStart.getTime());
      const overlapEnd = Math.min(end.getTime(), dayWorkEnd.getTime());
      if (overlapStart < overlapEnd) {
        total += overlapEnd - overlapStart;
      }
    }
    // Jump to next day at work start
    const next = new Date(cursor);
    next.setDate(next.getDate() + 1);
    next.setHours(WORK_START_H, 0, 0, 0);
    cursor = next;
  }
  return total;
};

const formatWorkTime = (ms) => {
  if (!ms || ms <= 0) return "0min";
  const totalMins = Math.floor(ms / 60000);
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hrs === 0) return `${mins}min`;
  return `${hrs}h${mins > 0 ? ` ${mins}min` : ""}`;
};

const PRIORITY_COLORS = {
  critical: "#ff3b3b",
  high: "#ff8c42",
  medium: "#ffd166",
  low: "#6bcb77",
};

const PRIORITY_LABELS = {
  critical: "Crítica",
  high: "Alta",
  medium: "Média",
  low: "Baixa",
};

const STATUS_LABELS = {
  backlog: "Backlog",
  active: "Em andamento",
  paused: "Pausada",
  done: "Concluída",
};

const defaultState = {
  tasks: [],
  shifts: [],
  currentFocus: null,
};

export default function TaskShiftTracker() {
  const [state, setState] = useState(defaultState);
  const [view, setView] = useState("board");
  const [showAddTask, setShowAddTask] = useState(false);
  const [showShiftModal, setShowShiftModal] = useState(false);
  const [shiftTarget, setShiftTarget] = useState(null);
  const [newTask, setNewTask] = useState({ title: "", priority: "medium", deadline: "" });
  const [shiftReason, setShiftReason] = useState("");
  const [reportTask, setReportTask] = useState(null);
  const [filterPriority, setFilterPriority] = useState("all");
  const [showInterruptModal, setShowInterruptModal] = useState(false);
  const [interruptData, setInterruptData] = useState({ mode: "new", title: "", priority: "high", reason: "", existingTaskId: null });
  const [liveWorkTime, setLiveWorkTime] = useState(0);
  const loaded = useRef(false);

  // Live timer: recalculate every 30s for the focused task
  useEffect(() => {
    const tick = () => {
      if (state.currentFocus) {
        const task = state.tasks.find((t) => t.id === state.currentFocus);
        if (task && task.focusStartedAt) {
          const liveMs = calcBusinessMs(task.focusStartedAt, Date.now());
          setLiveWorkTime((task.workTimeMs || 0) + liveMs);
        }
      } else {
        setLiveWorkTime(0);
      }
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [state.currentFocus, state.tasks]);

  useEffect(() => {
    async function load() {
      try {
        const result = await window.storage.get(STORAGE_KEY);
        if (result && result.value) {
          setState(JSON.parse(result.value));
        }
      } catch (e) {}
      loaded.current = true;
    }
    load();
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    window.storage.set(STORAGE_KEY, JSON.stringify(state)).catch(() => {});
  }, [state]);

  const addTask = () => {
    if (!newTask.title.trim()) return;
    const task = {
      id: generateId(),
      title: newTask.title.trim(),
      priority: newTask.priority,
      status: "backlog",
      createdAt: Date.now(),
      deadline: newTask.deadline ? new Date(newTask.deadline).getTime() : null,
      originalPriority: newTask.priority,
      priorityChanges: 0,
      timesFocused: 0,
      timesPaused: 0,
      workTimeMs: 0,
      focusStartedAt: null,
    };
    setState((s) => ({ ...s, tasks: [...s.tasks, task] }));
    setNewTask({ title: "", priority: "medium", deadline: "" });
    setShowAddTask(false);
  };

  const startFocus = (taskId) => {
    if (state.currentFocus && state.currentFocus !== taskId) {
      setShiftTarget(taskId);
      setShowShiftModal(true);
      return;
    }
    applyFocus(taskId, null);
  };

  const applyFocus = (taskId, reason) => {
    setState((s) => {
      const prevFocusId = s.currentFocus;
      const now = Date.now();
      const newShifts = [];

      if (prevFocusId) {
        newShifts.push({
          id: generateId(),
          from: prevFocusId,
          to: taskId,
          reason: reason || "Sem motivo informado",
          timestamp: now,
        });
      }

      // Always log focus_start
      newShifts.push({
        id: generateId(),
        taskId: taskId,
        timestamp: now + 1,
        type: "focus_start",
      });

      const tasks = s.tasks.map((t) => {
        if (t.id === taskId) {
          return { ...t, status: "active", timesFocused: t.timesFocused + 1, focusStartedAt: now };
        }
        if (t.id === prevFocusId) {
          const earned = t.focusStartedAt ? calcBusinessMs(t.focusStartedAt, now) : 0;
          return { ...t, status: "paused", timesPaused: t.timesPaused + 1, workTimeMs: (t.workTimeMs || 0) + earned, focusStartedAt: null };
        }
        return t;
      });

      return {
        ...s,
        tasks,
        currentFocus: taskId,
        shifts: [...s.shifts, ...newShifts],
      };
    });
  };

  const confirmShift = () => {
    if (shiftTarget) {
      applyFocus(shiftTarget, shiftReason);
    }
    setShowShiftModal(false);
    setShiftTarget(null);
    setShiftReason("");
  };

  const applyInterruption = () => {
    const now = Date.now();

    if (interruptData.mode === "new") {
      if (!interruptData.title.trim()) return;
      const newTaskId = generateId();
      const task = {
        id: newTaskId,
        title: interruptData.title.trim(),
        priority: interruptData.priority,
        status: "active",
        createdAt: now,
        deadline: null,
        originalPriority: interruptData.priority,
        priorityChanges: 0,
        timesFocused: 1,
        timesPaused: 0,
        createdVia: "interruption",
        workTimeMs: 0,
        focusStartedAt: now,
      };

      setState((s) => {
        const prevFocusId = s.currentFocus;
        const newShifts = [];

        if (prevFocusId) {
          newShifts.push({
            id: generateId(),
            from: prevFocusId,
            to: newTaskId,
            reason: interruptData.reason || interruptData.title.trim(),
            timestamp: now,
            type: "interruption",
          });
        }

        newShifts.push({
          id: generateId(),
          taskId: newTaskId,
          timestamp: now + 1,
          type: "focus_start",
        });

        const tasks = [
          ...s.tasks.map((t) => {
            if (t.id === prevFocusId) {
              const earned = t.focusStartedAt ? calcBusinessMs(t.focusStartedAt, now) : 0;
              return { ...t, status: "paused", timesPaused: t.timesPaused + 1, workTimeMs: (t.workTimeMs || 0) + earned, focusStartedAt: null };
            }
            return t;
          }),
          task,
        ];

        return { ...s, tasks, currentFocus: newTaskId, shifts: [...s.shifts, ...newShifts] };
      });
    } else {
      // existing task
      const targetId = interruptData.existingTaskId;
      if (!targetId) return;

      setState((s) => {
        const prevFocusId = s.currentFocus;
        const newShifts = [];

        if (prevFocusId) {
          newShifts.push({
            id: generateId(),
            from: prevFocusId,
            to: targetId,
            reason: interruptData.reason || "Interrupção — tarefa existente puxada",
            timestamp: now,
            type: "interruption",
          });
        }

        newShifts.push({
          id: generateId(),
          taskId: targetId,
          timestamp: now + 1,
          type: "focus_start",
        });

        const tasks = s.tasks.map((t) => {
          if (t.id === targetId) return { ...t, status: "active", timesFocused: t.timesFocused + 1, focusStartedAt: now };
          if (t.id === prevFocusId) {
            const earned = t.focusStartedAt ? calcBusinessMs(t.focusStartedAt, now) : 0;
            return { ...t, status: "paused", timesPaused: t.timesPaused + 1, workTimeMs: (t.workTimeMs || 0) + earned, focusStartedAt: null };
          }
          return t;
        });

        return { ...s, tasks, currentFocus: targetId, shifts: [...s.shifts, ...newShifts] };
      });
    }

    setInterruptData({ mode: "new", title: "", priority: "high", reason: "", existingTaskId: null });
    setShowInterruptModal(false);
  };

  const completeTask = (taskId) => {
    const now = Date.now();
    setState((s) => ({
      ...s,
      tasks: s.tasks.map((t) => {
        if (t.id === taskId) {
          const earned = t.focusStartedAt ? calcBusinessMs(t.focusStartedAt, now) : 0;
          return { ...t, status: "done", completedAt: now, workTimeMs: (t.workTimeMs || 0) + earned, focusStartedAt: null };
        }
        return t;
      }),
      currentFocus: s.currentFocus === taskId ? null : s.currentFocus,
    }));
  };

  const changePriority = (taskId, newPriority) => {
    setState((s) => {
      const task = s.tasks.find((t) => t.id === taskId);
      if (!task || task.priority === newPriority) return s;
      const shift = {
        id: generateId(),
        from: taskId,
        to: taskId,
        reason: `Prioridade alterada: ${PRIORITY_LABELS[task.priority]} → ${PRIORITY_LABELS[newPriority]}`,
        timestamp: Date.now(),
        type: "priority_change",
      };
      return {
        ...s,
        tasks: s.tasks.map((t) =>
          t.id === taskId ? { ...t, priority: newPriority, priorityChanges: t.priorityChanges + 1 } : t
        ),
        shifts: [...s.shifts, shift],
      };
    });
  };

  const deleteTask = (taskId) => {
    setState((s) => ({
      ...s,
      tasks: s.tasks.filter((t) => t.id !== taskId),
      currentFocus: s.currentFocus === taskId ? null : s.currentFocus,
    }));
  };

  const getTaskById = (id) => state.tasks.find((t) => t.id === id);
  const focusedTask = state.currentFocus ? getTaskById(state.currentFocus) : null;

  const getTaskShifts = (taskId) =>
    state.shifts.filter((s) => s.from === taskId || s.to === taskId || s.taskId === taskId);

  const activeTasks = state.tasks.filter((t) => t.status !== "done");
  const doneTasks = state.tasks.filter((t) => t.status === "done");
  const filteredTasks = filterPriority === "all" ? activeTasks : activeTasks.filter((t) => t.priority === filterPriority);

  const totalShifts = state.shifts.filter((s) => s.type !== "priority_change" && s.type !== "focus_start").length;
  const mostInterrupted = [...state.tasks].sort((a, b) => b.timesPaused - a.timesPaused)[0];

  // ─── STYLES ─────────────────────────────────────
  const font = "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace";
  const fontDisplay = "'Space Grotesk', 'Outfit', sans-serif";

  // Actually let me pick more unique fonts
  const styles = {
    app: {
      fontFamily: font,
      minHeight: "100vh",
      background: "#0a0a0f",
      color: "#c8c8d0",
      fontSize: 13,
      lineHeight: 1.5,
    },
    header: {
      padding: "20px 24px 16px",
      borderBottom: "1px solid #1a1a2e",
    },
    title: {
      fontSize: 18,
      fontWeight: 700,
      color: "#e8e8f0",
      letterSpacing: "-0.02em",
      margin: 0,
    },
    subtitle: {
      fontSize: 11,
      color: "#5a5a70",
      marginTop: 4,
      textTransform: "uppercase",
      letterSpacing: "0.08em",
    },
    nav: {
      display: "flex",
      gap: 2,
      padding: "12px 24px 0",
      borderBottom: "1px solid #1a1a2e",
    },
    navBtn: (active) => ({
      padding: "8px 16px",
      background: active ? "#1a1a2e" : "transparent",
      color: active ? "#e8e8f0" : "#5a5a70",
      border: "none",
      borderBottom: active ? "2px solid #ff8c42" : "2px solid transparent",
      cursor: "pointer",
      fontFamily: font,
      fontSize: 12,
      fontWeight: 500,
      letterSpacing: "0.03em",
      transition: "all 0.15s",
    }),
    content: {
      padding: 24,
    },
    focusBanner: {
      background: "linear-gradient(135deg, #1a1a2e 0%, #12121f 100%)",
      border: "1px solid #2a2a3e",
      borderRadius: 8,
      padding: "16px 20px",
      marginBottom: 20,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    focusLabel: {
      fontSize: 10,
      color: "#ff8c42",
      textTransform: "uppercase",
      letterSpacing: "0.12em",
      fontWeight: 700,
    },
    focusTitle: {
      fontSize: 15,
      color: "#e8e8f0",
      fontWeight: 600,
      marginTop: 2,
    },
    statsRow: {
      display: "flex",
      gap: 12,
      marginBottom: 20,
      flexWrap: "wrap",
    },
    statCard: {
      flex: "1 1 120px",
      background: "#12121f",
      border: "1px solid #1a1a2e",
      borderRadius: 6,
      padding: "12px 14px",
      minWidth: 120,
    },
    statValue: {
      fontSize: 22,
      fontWeight: 700,
      color: "#e8e8f0",
    },
    statLabel: {
      fontSize: 10,
      color: "#5a5a70",
      textTransform: "uppercase",
      letterSpacing: "0.1em",
      marginTop: 2,
    },
    taskCard: (isFocus, priority) => ({
      background: isFocus ? "#1a1a2e" : "#0f0f1a",
      border: `1px solid ${isFocus ? PRIORITY_COLORS[priority] + "55" : "#1a1a2e"}`,
      borderLeft: `3px solid ${PRIORITY_COLORS[priority]}`,
      borderRadius: 6,
      padding: "12px 14px",
      marginBottom: 8,
      transition: "all 0.15s",
      position: "relative",
    }),
    taskTitle: {
      fontSize: 13,
      fontWeight: 600,
      color: "#e8e8f0",
    },
    taskMeta: {
      fontSize: 11,
      color: "#5a5a70",
      marginTop: 4,
      display: "flex",
      gap: 12,
      flexWrap: "wrap",
      alignItems: "center",
    },
    badge: (color) => ({
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 3,
      fontSize: 10,
      fontWeight: 600,
      background: color + "18",
      color: color,
      textTransform: "uppercase",
      letterSpacing: "0.06em",
    }),
    btn: (color = "#ff8c42", ghost = false) => ({
      padding: "6px 12px",
      background: ghost ? "transparent" : color,
      color: ghost ? color : "#0a0a0f",
      border: ghost ? `1px solid ${color}44` : "none",
      borderRadius: 4,
      cursor: "pointer",
      fontFamily: font,
      fontSize: 11,
      fontWeight: 600,
      transition: "all 0.15s",
      letterSpacing: "0.02em",
    }),
    btnSmall: (color = "#5a5a70") => ({
      padding: "3px 8px",
      background: "transparent",
      color: color,
      border: `1px solid ${color}33`,
      borderRadius: 3,
      cursor: "pointer",
      fontFamily: font,
      fontSize: 10,
      transition: "all 0.15s",
    }),
    input: {
      background: "#12121f",
      border: "1px solid #2a2a3e",
      borderRadius: 4,
      padding: "8px 12px",
      color: "#e8e8f0",
      fontFamily: font,
      fontSize: 12,
      outline: "none",
      width: "100%",
      boxSizing: "border-box",
    },
    select: {
      background: "#12121f",
      border: "1px solid #2a2a3e",
      borderRadius: 4,
      padding: "8px 12px",
      color: "#e8e8f0",
      fontFamily: font,
      fontSize: 12,
      outline: "none",
      cursor: "pointer",
    },
    modal: {
      position: "fixed",
      inset: 0,
      background: "#0a0a0fdd",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 100,
      backdropFilter: "blur(4px)",
    },
    modalContent: {
      background: "#12121f",
      border: "1px solid #2a2a3e",
      borderRadius: 8,
      padding: 24,
      width: "90%",
      maxWidth: 440,
    },
    timeline: {
      position: "relative",
      paddingLeft: 24,
    },
    timelineItem: (type) => ({
      position: "relative",
      paddingBottom: 20,
      paddingLeft: 16,
      borderLeft: `2px solid ${type === "priority_change" ? "#ffd166" : type === "interruption" ? "#ff3b3b" : type === "focus_start" ? "#6bcb77" : "#ff8c42"}33`,
    }),
    timelineDot: (type) => ({
      position: "absolute",
      left: -7,
      top: 2,
      width: 12,
      height: 12,
      borderRadius: "50%",
      background: type === "priority_change" ? "#ffd166" : type === "interruption" ? "#ff3b3b" : type === "focus_start" ? "#6bcb77" : "#ff8c42",
      border: "2px solid #0a0a0f",
    }),
    reportCard: {
      background: "#12121f",
      border: "1px solid #2a2a3e",
      borderRadius: 8,
      padding: 20,
      marginBottom: 16,
    },
    filterRow: {
      display: "flex",
      gap: 6,
      marginBottom: 16,
      flexWrap: "wrap",
      alignItems: "center",
    },
    filterChip: (active) => ({
      padding: "4px 10px",
      borderRadius: 3,
      fontSize: 10,
      fontWeight: 600,
      background: active ? "#ff8c4222" : "#1a1a2e",
      color: active ? "#ff8c42" : "#5a5a70",
      border: `1px solid ${active ? "#ff8c4244" : "#2a2a3e"}`,
      cursor: "pointer",
      fontFamily: font,
      textTransform: "uppercase",
      letterSpacing: "0.06em",
      transition: "all 0.15s",
    }),
    empty: {
      textAlign: "center",
      padding: 40,
      color: "#3a3a50",
    },
    actions: {
      display: "flex",
      gap: 6,
      marginTop: 8,
      flexWrap: "wrap",
    },
  };

  // ─── RENDER ─────────────────────────────────────

  const renderBoard = () => (
    <div>
      {/* Focus Banner */}
      {focusedTask ? (
        <div style={styles.focusBanner}>
          <div>
            <div style={styles.focusLabel}>▸ Foco atual</div>
            <div style={styles.focusTitle}>{focusedTask.title}</div>
            <div style={{ fontSize: 11, color: "#5a5a70", marginTop: 4 }}>
              {focusedTask.deadline
                ? `Prazo: ${formatDate(focusedTask.deadline)}`
                : "Sem prazo definido"}{" "}
              · Pausada {focusedTask.timesPaused}x
              · <span style={{ color: "#82aaff", fontWeight: 600 }}>⏱ {formatWorkTime(liveWorkTime)}</span>
              <span style={{ color: "#5a5a70", marginLeft: 4, fontSize: 10 }}>(horas úteis)</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={styles.btn("#ff3b3b")} onClick={() => setShowInterruptModal(true)}>
              ⚡ Interrupção
            </button>
            <button style={styles.btn("#6bcb77")} onClick={() => completeTask(focusedTask.id)}>
              ✓ Concluir
            </button>
          </div>
        </div>
      ) : (
        <div style={{ ...styles.focusBanner, borderColor: "#2a2a3e55", opacity: 0.7 }}>
          <div>
            <div style={styles.focusLabel}>Nenhum foco definido</div>
            <div style={{ ...styles.focusTitle, color: "#5a5a70" }}>
              Selecione uma tarefa para focar
            </div>
          </div>
        </div>
      )}

      {/* Stats */}
      <div style={styles.statsRow}>
        <div style={styles.statCard}>
          <div style={styles.statValue}>{activeTasks.length}</div>
          <div style={styles.statLabel}>Ativas</div>
        </div>
        <div style={styles.statCard}>
          <div style={{ ...styles.statValue, color: "#ff3b3b" }}>
            {state.shifts.filter((s) => s.type === "interruption").length}
          </div>
          <div style={styles.statLabel}>Interrupções</div>
        </div>
        <div style={styles.statCard}>
          <div style={{ ...styles.statValue, color: "#ff8c42" }}>{totalShifts}</div>
          <div style={styles.statLabel}>Trocas de foco</div>
        </div>
        <div style={styles.statCard}>
          <div style={{ ...styles.statValue, color: "#ffd166" }}>
            {state.shifts.filter((s) => s.type === "priority_change").length}
          </div>
          <div style={styles.statLabel}>Repriorização</div>
        </div>
        <div style={styles.statCard}>
          <div style={{ ...styles.statValue, color: "#6bcb77" }}>{doneTasks.length}</div>
          <div style={styles.statLabel}>Concluídas</div>
        </div>
      </div>

      {/* Filters + Add */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={styles.filterRow}>
          <button style={styles.filterChip(filterPriority === "all")} onClick={() => setFilterPriority("all")}>
            Todas
          </button>
          {Object.entries(PRIORITY_LABELS).map(([k, v]) => (
            <button key={k} style={styles.filterChip(filterPriority === k)} onClick={() => setFilterPriority(k)}>
              <span style={{ color: PRIORITY_COLORS[k], marginRight: 4 }}>●</span> {v}
            </button>
          ))}
        </div>
        <button style={styles.btn()} onClick={() => setShowAddTask(true)}>
          + Tarefa
        </button>
      </div>

      {/* Task List */}
      {filteredTasks.length === 0 ? (
        <div style={styles.empty}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>∅</div>
          <div>Nenhuma tarefa ativa</div>
        </div>
      ) : (
        filteredTasks
          .sort((a, b) => {
            const ord = { critical: 0, high: 1, medium: 2, low: 3 };
            return ord[a.priority] - ord[b.priority];
          })
          .map((task) => {
            const isFocus = state.currentFocus === task.id;
            const shifts = getTaskShifts(task.id);
            return (
              <div key={task.id} style={styles.taskCard(isFocus, task.priority)}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={styles.taskTitle}>
                    {isFocus && <span style={{ color: "#ff8c42", marginRight: 6 }}>▸</span>}
                    {task.title}
                  </div>
                  <span style={styles.badge(PRIORITY_COLORS[task.priority])}>
                    {PRIORITY_LABELS[task.priority]}
                  </span>
                </div>
                <div style={styles.taskMeta}>
                  <span>Criada {formatDate(task.createdAt)}</span>
                  {task.createdVia === "interruption" && (
                    <span style={styles.badge("#ff3b3b")}>⚡ Interrupção</span>
                  )}
                  {task.deadline && <span>Prazo: {formatDate(task.deadline)}</span>}
                  <span style={styles.badge(task.status === "paused" ? "#ff8c42" : task.status === "active" ? "#6bcb77" : "#5a5a70")}>
                    {STATUS_LABELS[task.status]}
                  </span>
                  {task.timesPaused > 0 && (
                    <span style={{ color: "#ff3b3b" }}>⏸ Pausada {task.timesPaused}x</span>
                  )}
                  {task.priorityChanges > 0 && (
                    <span style={{ color: "#ffd166" }}>↕ Repriorizada {task.priorityChanges}x</span>
                  )}
                  {((isFocus && liveWorkTime > 0) || (!isFocus && (task.workTimeMs || 0) > 0)) && (
                    <span style={{ color: "#82aaff" }}>⏱ {formatWorkTime(isFocus ? liveWorkTime : task.workTimeMs || 0)}</span>
                  )}
                </div>
                <div style={styles.actions}>
                  {!isFocus && task.status !== "done" && (
                    <button style={styles.btnSmall("#ff8c42")} onClick={() => startFocus(task.id)}>
                      ▸ Focar
                    </button>
                  )}
                  {task.status !== "done" && (
                    <button style={styles.btnSmall("#6bcb77")} onClick={() => completeTask(task.id)}>
                      ✓ Concluir
                    </button>
                  )}
                  <select
                    style={{ ...styles.select, padding: "3px 8px", fontSize: 10, border: "1px solid #2a2a3e33" }}
                    value={task.priority}
                    onChange={(e) => changePriority(task.id, e.target.value)}
                  >
                    {Object.entries(PRIORITY_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                  <button style={styles.btnSmall("#ff3b3b")} onClick={() => deleteTask(task.id)}>
                    ✕
                  </button>
                  {shifts.length > 0 && (
                    <button style={styles.btnSmall("#ffd166")} onClick={() => { setReportTask(task.id); setView("report"); }}>
                      ◈ Parecer
                    </button>
                  )}
                </div>
              </div>
            );
          })
      )}

      {/* Completed */}
      {doneTasks.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ fontSize: 11, color: "#5a5a70", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>
            Concluídas ({doneTasks.length})
          </div>
          {doneTasks.slice(-5).reverse().map((task) => (
            <div key={task.id} style={{ ...styles.taskCard(false, task.priority), opacity: 0.5 }}>
              <div style={{ ...styles.taskTitle, textDecoration: "line-through" }}>{task.title}</div>
              <div style={styles.taskMeta}>
                <span>Concluída {formatDateTime(task.completedAt)}</span>
                {task.timesPaused > 0 && <span style={{ color: "#ff3b3b" }}>Pausada {task.timesPaused}x</span>}
                {(task.workTimeMs || 0) > 0 && <span style={{ color: "#82aaff" }}>⏱ {formatWorkTime(task.workTimeMs)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderTimeline = () => {
    // Consolidate: merge focus_start into the preceding shift/interruption
    // Only show standalone focus_start if it has no preceding shift in the same second
    const consolidated = [];
    const sorted = [...state.shifts].sort((a, b) => a.timestamp - b.timestamp);

    for (let i = 0; i < sorted.length; i++) {
      const ev = sorted[i];
      if (ev.type === "focus_start") {
        // Check if previous event is a shift/interruption that leads to this task
        const prev = consolidated[consolidated.length - 1];
        if (prev && (prev.to === ev.taskId || prev.from === ev.taskId) && Math.abs(prev.timestamp - ev.timestamp) < 5000) {
          prev._focusTarget = ev.taskId;
          continue; // skip, it's merged
        }
        // Standalone first focus
        consolidated.push({ ...ev, _standalone: true });
      } else {
        consolidated.push({ ...ev });
      }
    }

    // Group by day
    const byDay = {};
    consolidated.forEach((ev) => {
      const dayKey = new Date(ev.timestamp).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
      if (!byDay[dayKey]) byDay[dayKey] = [];
      byDay[dayKey].push(ev);
    });

    const dayKeys = Object.keys(byDay).reverse();

    const typeConfig = {
      interruption: { icon: "⚡", label: "Interrupção", color: "#ff3b3b", bg: "#ff3b3b0a" },
      priority_change: { icon: "↕", label: "Repriorização", color: "#ffd166", bg: "#ffd1660a" },
      focus_start: { icon: "▸", label: "Foco iniciado", color: "#6bcb77", bg: "#6bcb770a" },
      default: { icon: "↻", label: "Troca de contexto", color: "#ff8c42", bg: "#ff8c420a" },
    };

    const getConfig = (type) => typeConfig[type] || typeConfig.default;

    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#e8e8f0" }}>
            Timeline de Mudanças
          </div>
          <div style={{ fontSize: 11, color: "#5a5a70" }}>
            {consolidated.length} evento{consolidated.length !== 1 ? "s" : ""}
          </div>
        </div>

        {consolidated.length === 0 ? (
          <div style={styles.empty}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>◇</div>
            <div>Nenhuma troca de contexto registrada</div>
          </div>
        ) : (
          dayKeys.map((dayKey) => {
            const events = byDay[dayKey];
            return (
              <div key={dayKey} style={{ marginBottom: 24 }}>
                {/* Day header */}
                <div style={{
                  fontSize: 10, fontWeight: 700, color: "#5a5a70", textTransform: "uppercase",
                  letterSpacing: "0.12em", marginBottom: 12, paddingBottom: 6,
                  borderBottom: "1px solid #1a1a2e",
                }}>
                  {dayKey}
                </div>

                {[...events].reverse().map((ev, idx) => {
                  const cfg = getConfig(ev.type);
                  const fromTask = getTaskById(ev.from);
                  const toTask = getTaskById(ev.to);
                  const focusTask = getTaskById(ev.taskId);
                  const time = new Date(ev.timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

                  // Time gap to next event
                  const reversedEvents = [...events].reverse();
                  const nextEv = reversedEvents[idx + 1];
                  const gap = nextEv ? calcBusinessMs(nextEv.timestamp, ev.timestamp) : null;

                  return (
                    <div key={ev.id}>
                      <div style={{
                        display: "flex", gap: 12, marginBottom: gap && gap > 60000 ? 4 : 10,
                      }}>
                        {/* Time column */}
                        <div style={{
                          width: 48, flexShrink: 0, fontSize: 11, fontWeight: 600,
                          color: cfg.color, textAlign: "right", paddingTop: 10,
                          fontVariantNumeric: "tabular-nums",
                        }}>
                          {time}
                        </div>

                        {/* Vertical line */}
                        <div style={{
                          width: 20, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center",
                        }}>
                          <div style={{
                            width: 10, height: 10, borderRadius: "50%", background: cfg.color,
                            border: "2px solid #0a0a0f", flexShrink: 0, marginTop: 10, zIndex: 1,
                          }} />
                          <div style={{
                            width: 2, flex: 1, background: `${cfg.color}22`, marginTop: -1,
                          }} />
                        </div>

                        {/* Event card */}
                        <div style={{
                          flex: 1, background: cfg.bg, border: `1px solid ${cfg.color}15`,
                          borderRadius: 6, padding: "10px 14px", minWidth: 0,
                        }}>
                          {/* Header */}
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: ev.type === "priority_change" || ev._standalone ? 0 : 6 }}>
                            <span style={{
                              fontSize: 10, fontWeight: 700, color: cfg.color,
                              textTransform: "uppercase", letterSpacing: "0.08em",
                              background: `${cfg.color}15`, padding: "2px 6px", borderRadius: 3,
                            }}>
                              {cfg.icon} {cfg.label}
                            </span>
                          </div>

                          {/* Content by type */}
                          {ev._standalone ? (
                            <div style={{ fontSize: 12, color: "#e8e8f0", marginTop: 6 }}>
                              <strong>{focusTask?.title || "Tarefa removida"}</strong>
                              <span style={{ color: "#5a5a70" }}> entrou em execução</span>
                            </div>
                          ) : ev.type === "priority_change" ? (
                            <div style={{ fontSize: 12, marginTop: 6 }}>
                              <strong style={{ color: "#e8e8f0" }}>{fromTask?.title || "Tarefa removida"}</strong>
                              <div style={{ color: "#8a8a9a", fontSize: 11, marginTop: 3 }}>{ev.reason}</div>
                            </div>
                          ) : ev.type === "interruption" ? (
                            <div style={{ fontSize: 12 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <span style={{
                                  padding: "3px 8px", borderRadius: 3, fontSize: 11, fontWeight: 600,
                                  background: "#ff8c4212", color: "#ff8c42", border: "1px solid #ff8c4220",
                                }}>
                                  ⏸ {fromTask?.title || "Removida"}
                                </span>
                                <span style={{ color: "#5a5a70", fontSize: 13 }}>→</span>
                                <span style={{
                                  padding: "3px 8px", borderRadius: 3, fontSize: 11, fontWeight: 600,
                                  background: "#6bcb7712", color: "#6bcb77", border: "1px solid #6bcb7720",
                                }}>
                                  ▸ {toTask?.title || "Removida"}
                                </span>
                              </div>
                              {ev.reason && ev.reason !== (toTask?.title || "") && (
                                <div style={{
                                  fontSize: 11, color: "#8a8a9a", marginTop: 8, paddingTop: 8,
                                  borderTop: "1px solid #ffffff08", fontStyle: "italic",
                                }}>
                                  "{ev.reason}"
                                </div>
                              )}
                            </div>
                          ) : (
                            /* Regular context switch */
                            <div style={{ fontSize: 12 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <span style={{
                                  padding: "3px 8px", borderRadius: 3, fontSize: 11, fontWeight: 600,
                                  background: "#ff8c4212", color: "#ff8c42", border: "1px solid #ff8c4220",
                                }}>
                                  ⏸ {fromTask?.title || "Removida"}
                                </span>
                                <span style={{ color: "#5a5a70", fontSize: 13 }}>→</span>
                                <span style={{
                                  padding: "3px 8px", borderRadius: 3, fontSize: 11, fontWeight: 600,
                                  background: "#6bcb7712", color: "#6bcb77", border: "1px solid #6bcb7720",
                                }}>
                                  ▸ {toTask?.title || "Removida"}
                                </span>
                              </div>
                              {ev.reason && (
                                <div style={{
                                  fontSize: 11, color: "#8a8a9a", marginTop: 8, paddingTop: 8,
                                  borderTop: "1px solid #ffffff08", fontStyle: "italic",
                                }}>
                                  "{ev.reason}"
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Time gap indicator */}
                      {gap && gap > 60000 && (
                        <div style={{
                          display: "flex", gap: 12, marginBottom: 10,
                        }}>
                          <div style={{ width: 48, flexShrink: 0 }} />
                          <div style={{
                            width: 20, flexShrink: 0, display: "flex", justifyContent: "center",
                          }}>
                            <div style={{ width: 2, height: 20, background: "#1a1a2e" }} />
                          </div>
                          <div style={{
                            fontSize: 10, color: "#5a5a70", padding: "2px 0",
                            display: "flex", alignItems: "center", gap: 4,
                          }}>
                            <span style={{ color: "#82aaff" }}>⏱</span> {formatWorkTime(gap)} entre eventos
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    );
  };

  const renderReport = () => {
    const targetTask = reportTask ? getTaskById(reportTask) : null;
    const tasksForReport = targetTask ? [targetTask] : activeTasks.filter((t) => getTaskShifts(t.id).length > 0);

    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#e8e8f0" }}>
            {targetTask ? `Parecer: ${targetTask.title}` : "Parecer Geral"}
          </div>
          {reportTask && (
            <button style={styles.btnSmall("#5a5a70")} onClick={() => setReportTask(null)}>
              Ver todas
            </button>
          )}
        </div>

        {/* General summary */}
        {!targetTask && (
          <div style={styles.reportCard}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#ff8c42", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Resumo Executivo
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.7, color: "#c8c8d0" }}>
              No período atual, foram registradas <strong style={{ color: "#e8e8f0" }}>{totalShifts} trocas de contexto</strong>,{" "}
              <strong style={{ color: "#ff3b3b" }}>
                {state.shifts.filter((s) => s.type === "interruption").length} interrupção(ões)
              </strong> e{" "}
              <strong style={{ color: "#e8e8f0" }}>
                {state.shifts.filter((s) => s.type === "priority_change").length} repriorização(ões)
              </strong>{" "}
              entre <strong style={{ color: "#e8e8f0" }}>{state.tasks.length} tarefas</strong>.
              {" "}<strong style={{ color: "#ffd166" }}>{state.tasks.filter((t) => t.createdVia === "interruption").length}</strong> tarefa(s) foram criadas diretamente por interrupções.
              {mostInterrupted && mostInterrupted.timesPaused > 0 && (
                <span>
                  {" "}
                  A tarefa mais impactada foi{" "}
                  <strong style={{ color: "#ffd166" }}>"{mostInterrupted.title}"</strong>, pausada{" "}
                  {mostInterrupted.timesPaused}x.
                </span>
              )}
            </div>
          </div>
        )}

        {tasksForReport.length === 0 ? (
          <div style={styles.empty}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>◈</div>
            <div>Nenhuma tarefa com histórico de mudanças</div>
          </div>
        ) : (
          tasksForReport.map((task) => {
            const shifts = getTaskShifts(task.id);
            const focusShifts = shifts.filter((s) => s.type !== "priority_change");
            const priorityShifts = shifts.filter((s) => s.type === "priority_change");
            const interruptions = state.shifts.filter((s) => s.from === task.id && s.type !== "priority_change");

            return (
              <div key={task.id} style={styles.reportCard}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#e8e8f0" }}>{task.title}</div>
                    <div style={{ fontSize: 11, color: "#5a5a70", marginTop: 2 }}>
                      Criada em {formatDateTime(task.createdAt)}
                      {task.deadline && ` · Prazo: ${formatDate(task.deadline)}`}
                    </div>
                  </div>
                  <span style={styles.badge(PRIORITY_COLORS[task.priority])}>
                    {PRIORITY_LABELS[task.priority]}
                  </span>
                </div>

                {/* Origin badge */}
                {task.createdVia === "interruption" && (
                  <div style={{ fontSize: 11, marginBottom: 10, padding: "5px 10px", background: "#ff3b3b12", borderRadius: 4, color: "#ff3b3b", fontWeight: 600 }}>
                    ⚡ Tarefa criada por interrupção
                  </div>
                )}

                {/* Impact numbers */}
                <div style={{ display: "flex", gap: 16, marginBottom: 14, flexWrap: "wrap" }}>
                  <div>
                    <span style={{ fontSize: 18, fontWeight: 700, color: "#82aaff" }}>
                      {formatWorkTime(
                        state.currentFocus === task.id && task.focusStartedAt
                          ? (task.workTimeMs || 0) + calcBusinessMs(task.focusStartedAt, Date.now())
                          : task.workTimeMs || 0
                      )}
                    </span>
                    <span style={{ fontSize: 10, color: "#5a5a70", marginLeft: 6 }}>HORAS ÚTEIS</span>
                  </div>
                  <div>
                    <span style={{ fontSize: 18, fontWeight: 700, color: "#ff8c42" }}>{task.timesPaused}</span>
                    <span style={{ fontSize: 10, color: "#5a5a70", marginLeft: 6 }}>PAUSAS</span>
                  </div>
                  <div>
                    <span style={{ fontSize: 18, fontWeight: 700, color: "#ffd166" }}>{task.priorityChanges}</span>
                    <span style={{ fontSize: 10, color: "#5a5a70", marginLeft: 6 }}>REPRIORIZAÇÕES</span>
                  </div>
                  <div>
                    <span style={{ fontSize: 18, fontWeight: 700, color: "#e8e8f0" }}>{task.timesFocused}</span>
                    <span style={{ fontSize: 10, color: "#5a5a70", marginLeft: 6 }}>VEZES EM FOCO</span>
                  </div>
                </div>

                {/* Original vs current priority */}
                {task.originalPriority !== task.priority && (
                  <div style={{ fontSize: 11, marginBottom: 12, padding: "6px 10px", background: "#ffd16612", borderRadius: 4, color: "#ffd166" }}>
                    Prioridade original: <strong>{PRIORITY_LABELS[task.originalPriority]}</strong> → Atual:{" "}
                    <strong>{PRIORITY_LABELS[task.priority]}</strong>
                  </div>
                )}

                {/* Created via interruption badge */}
                {task.createdVia === "interruption" && (
                  <div style={{ fontSize: 11, marginBottom: 12, padding: "6px 10px", background: "#ff3b3b12", borderRadius: 4, color: "#ff3b3b" }}>
                    ⚡ Tarefa criada por interrupção — surgiu como demanda urgente durante outra atividade
                  </div>
                )}

                {/* Interruption details */}
                {interruptions.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 10, color: "#ff8c42", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8, fontWeight: 700 }}>
                      Interrupções sofridas
                    </div>
                    {interruptions.map((s) => {
                      const toTask = getTaskById(s.to);
                      const isInterruptionType = s.type === "interruption";
                      return (
                        <div key={s.id} style={{ fontSize: 11, padding: "6px 10px", background: isInterruptionType ? "#ff3b3b08" : "#ff8c4208", borderLeft: `2px solid ${isInterruptionType ? "#ff3b3b44" : "#ff8c4244"}`, marginBottom: 6, borderRadius: "0 4px 4px 0" }}>
                          <span style={{ color: "#5a5a70" }}>{formatDateTime(s.timestamp)}</span>
                          {isInterruptionType && <span style={{ color: "#ff3b3b", fontWeight: 600 }}> ⚡</span>}
                          <span style={{ color: "#8a8a9a" }}> — Pausada para {isInterruptionType ? "atender interrupção" : "focar em"} </span>
                          <span style={{ color: "#e8e8f0", fontWeight: 600 }}>{toTask?.title || "tarefa removida"}</span>
                          <div style={{ color: "#5a5a70", fontStyle: "italic", marginTop: 2 }}>
                            Motivo: "{s.reason}"
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Priority change details */}
                {priorityShifts.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 10, color: "#ffd166", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8, fontWeight: 700 }}>
                      Alterações de prioridade
                    </div>
                    {priorityShifts.map((s) => (
                      <div key={s.id} style={{ fontSize: 11, padding: "6px 10px", background: "#ffd16608", borderLeft: "2px solid #ffd16644", marginBottom: 6, borderRadius: "0 4px 4px 0" }}>
                        <span style={{ color: "#5a5a70" }}>{formatDateTime(s.timestamp)}</span>
                        <span style={{ color: "#8a8a9a" }}> — {s.reason}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    );
  };

  return (
    <div style={styles.app}>
      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.title}>SHIFT TRACKER</h1>
        <div style={styles.subtitle}>Rastreador de mudanças de prioridade & contexto</div>
      </div>

      {/* Nav */}
      <div style={styles.nav}>
        <button style={styles.navBtn(view === "board")} onClick={() => setView("board")}>
          Board
        </button>
        <button style={styles.navBtn(view === "timeline")} onClick={() => setView("timeline")}>
          Timeline
        </button>
        <button style={styles.navBtn(view === "report")} onClick={() => { setView("report"); setReportTask(null); }}>
          Parecer
        </button>
      </div>

      {/* Content */}
      <div style={styles.content}>
        {view === "board" && renderBoard()}
        {view === "timeline" && renderTimeline()}
        {view === "report" && renderReport()}
      </div>

      {/* Add Task Modal */}
      {showAddTask && (
        <div style={styles.modal} onClick={() => setShowAddTask(false)}>
          <div style={styles.modalContent} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#e8e8f0", marginBottom: 16 }}>
              Nova tarefa
            </div>
            <div style={{ marginBottom: 12 }}>
              <input
                style={styles.input}
                placeholder="Nome da tarefa..."
                value={newTask.title}
                onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && addTask()}
              />
            </div>
            <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
              <select
                style={{ ...styles.select, flex: 1 }}
                value={newTask.priority}
                onChange={(e) => setNewTask({ ...newTask, priority: e.target.value })}
              >
                {Object.entries(PRIORITY_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <input
                style={{ ...styles.input, flex: 1 }}
                type="date"
                value={newTask.deadline}
                onChange={(e) => setNewTask({ ...newTask, deadline: e.target.value })}
              />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={styles.btn("#5a5a70", true)} onClick={() => setShowAddTask(false)}>
                Cancelar
              </button>
              <button style={styles.btn()} onClick={addTask}>
                Adicionar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Shift Context Modal */}
      {showShiftModal && (
        <div style={styles.modal}>
          <div style={styles.modalContent} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#ff8c42", marginBottom: 4 }}>
              ⚠ Troca de contexto
            </div>
            <div style={{ fontSize: 12, color: "#8a8a9a", marginBottom: 16 }}>
              Você está saindo de{" "}
              <strong style={{ color: "#e8e8f0" }}>{focusedTask?.title}</strong> para focar em{" "}
              <strong style={{ color: "#e8e8f0" }}>{getTaskById(shiftTarget)?.title}</strong>.
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "#5a5a70", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Por que você está trocando?
              </div>
              <textarea
                style={{ ...styles.input, minHeight: 80, resize: "vertical" }}
                placeholder="Ex: Gerente pediu prioridade para outra demanda..."
                value={shiftReason}
                onChange={(e) => setShiftReason(e.target.value)}
                autoFocus
              />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                style={styles.btn("#5a5a70", true)}
                onClick={() => { setShowShiftModal(false); setShiftTarget(null); setShiftReason(""); }}
              >
                Cancelar
              </button>
              <button style={styles.btn("#ff8c42")} onClick={confirmShift}>
                Confirmar troca
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Interruption Modal */}
      {showInterruptModal && (
        <div style={styles.modal} onClick={() => setShowInterruptModal(false)}>
          <div style={{ ...styles.modalContent, maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#ff3b3b", marginBottom: 4 }}>
              ⚡ Registrar Interrupção
            </div>
            <div style={{ fontSize: 12, color: "#8a8a9a", marginBottom: 16 }}>
              A tarefa <strong style={{ color: "#e8e8f0" }}>{focusedTask?.title}</strong> será pausada.
            </div>

            {/* Mode tabs */}
            <div style={{ display: "flex", gap: 2, marginBottom: 16 }}>
              <button
                style={{
                  flex: 1, padding: "8px 0", border: "none", borderRadius: "4px 4px 0 0", cursor: "pointer",
                  fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace", fontSize: 11, fontWeight: 600,
                  background: interruptData.mode === "new" ? "#ff3b3b22" : "#1a1a2e",
                  color: interruptData.mode === "new" ? "#ff3b3b" : "#5a5a70",
                  borderBottom: interruptData.mode === "new" ? "2px solid #ff3b3b" : "2px solid transparent",
                }}
                onClick={() => setInterruptData({ ...interruptData, mode: "new", existingTaskId: null })}
              >
                + Nova tarefa
              </button>
              <button
                style={{
                  flex: 1, padding: "8px 0", border: "none", borderRadius: "4px 4px 0 0", cursor: "pointer",
                  fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace", fontSize: 11, fontWeight: 600,
                  background: interruptData.mode === "existing" ? "#ff8c4222" : "#1a1a2e",
                  color: interruptData.mode === "existing" ? "#ff8c42" : "#5a5a70",
                  borderBottom: interruptData.mode === "existing" ? "2px solid #ff8c42" : "2px solid transparent",
                }}
                onClick={() => setInterruptData({ ...interruptData, mode: "existing", title: "", priority: "high" })}
              >
                Tarefa existente
              </button>
            </div>

            {interruptData.mode === "new" ? (
              <>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: "#5a5a70", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                    O que caiu no seu colo?
                  </div>
                  <input
                    style={styles.input}
                    placeholder="Nome da tarefa que te interrompeu..."
                    value={interruptData.title}
                    onChange={(e) => setInterruptData({ ...interruptData, title: e.target.value })}
                    autoFocus
                    onKeyDown={(e) => e.key === "Enter" && interruptData.title.trim() && applyInterruption()}
                  />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: "#5a5a70", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                    Prioridade
                  </div>
                  <select
                    style={{ ...styles.select, width: "100%" }}
                    value={interruptData.priority}
                    onChange={(e) => setInterruptData({ ...interruptData, priority: e.target.value })}
                  >
                    {Object.entries(PRIORITY_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
              </>
            ) : (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: "#5a5a70", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  Selecione a tarefa
                </div>
                <div style={{ maxHeight: 200, overflowY: "auto", borderRadius: 4, border: "1px solid #2a2a3e" }}>
                  {state.tasks.filter((t) => t.status !== "done" && t.id !== state.currentFocus).length === 0 ? (
                    <div style={{ padding: 16, textAlign: "center", color: "#5a5a70", fontSize: 11 }}>
                      Nenhuma tarefa disponível
                    </div>
                  ) : (
                    state.tasks
                      .filter((t) => t.status !== "done" && t.id !== state.currentFocus)
                      .map((t) => (
                        <div
                          key={t.id}
                          onClick={() => setInterruptData({ ...interruptData, existingTaskId: t.id })}
                          style={{
                            padding: "10px 12px",
                            cursor: "pointer",
                            background: interruptData.existingTaskId === t.id ? "#ff8c4215" : "transparent",
                            borderLeft: interruptData.existingTaskId === t.id ? "3px solid #ff8c42" : "3px solid transparent",
                            borderBottom: "1px solid #1a1a2e",
                            transition: "all 0.1s",
                          }}
                        >
                          <div style={{ fontSize: 12, fontWeight: 600, color: interruptData.existingTaskId === t.id ? "#e8e8f0" : "#8a8a9a" }}>
                            {t.title}
                          </div>
                          <div style={{ fontSize: 10, color: "#5a5a70", marginTop: 2, display: "flex", gap: 8 }}>
                            <span style={{ color: PRIORITY_COLORS[t.priority] }}>● {PRIORITY_LABELS[t.priority]}</span>
                            <span>{STATUS_LABELS[t.status]}</span>
                            {t.timesPaused > 0 && <span>Pausada {t.timesPaused}x</span>}
                            {(t.workTimeMs || 0) > 0 && <span style={{ color: "#82aaff" }}>⏱ {formatWorkTime(t.workTimeMs)}</span>}
                          </div>
                        </div>
                      ))
                  )}
                </div>
              </div>
            )}

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "#5a5a70", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Motivo da interrupção (opcional)
              </div>
              <textarea
                style={{ ...styles.input, minHeight: 60, resize: "vertical" }}
                placeholder="Ex: Gerente pediu urgência, cliente reclamou, deploy quebrou..."
                value={interruptData.reason}
                onChange={(e) => setInterruptData({ ...interruptData, reason: e.target.value })}
              />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                style={styles.btn("#5a5a70", true)}
                onClick={() => { setShowInterruptModal(false); setInterruptData({ mode: "new", title: "", priority: "high", reason: "", existingTaskId: null }); }}
              >
                Cancelar
              </button>
              <button
                style={styles.btn("#ff3b3b")}
                onClick={applyInterruption}
                disabled={interruptData.mode === "new" ? !interruptData.title.trim() : !interruptData.existingTaskId}
              >
                ⚡ Registrar e trocar foco
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
