use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::storage::Store;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Idle,
    Study,
    Break,
}

impl Phase {
    pub fn as_str(&self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Study => "study",
            Phase::Break => "break",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Pomodoro,
    CountUp,
    CountDown,
}

impl Mode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Mode::Pomodoro => "pomodoro",
            Mode::CountUp => "countup",
            Mode::CountDown => "countdown",
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn secs_display(d: Duration) -> i64 {
    let ms = d.as_millis() as i64;
    if ms <= 0 {
        0
    } else {
        (ms + 999) / 1000
    }
}

pub struct Engine {
    pub phase: Phase,
    pub mode: Mode,
    pub paused: bool,
    pub pending: bool,
    pub auto_next: bool,
    deadline: Option<Instant>,
    /// Wall-clock deadline for notification/snapshot (epoch millis).
    deadline_epoch: Option<i64>,
    pub remaining: i64,
    pub elapsed_secs: i64,
    pub planned: i64,
    pub extended: i64,
    pub extended_count: i64,
    pub paused_ms: i64,
    pause_started: Option<Instant>,
    phase_start_ms: i64,
    pub cycle_index: i64,
    pub cycles: i64,
    pub category_id: Option<String>,
    pub event_id: Option<String>,
    finished_kind: Option<Phase>,
    finished_focused: i64,
    finished_completed: bool,
    study_secs: i64,
    break_secs: i64,
    extend_study_secs: i64,
    extend_break_secs: i64,
}

impl Default for Engine {
    fn default() -> Self {
        Engine {
            phase: Phase::Idle,
            mode: Mode::Pomodoro,
            paused: false,
            pending: false,
            auto_next: false,
            deadline: None,
            deadline_epoch: None,
            remaining: 0,
            elapsed_secs: 0,
            planned: 0,
            extended: 0,
            extended_count: 0,
            paused_ms: 0,
            pause_started: None,
            phase_start_ms: 0,
            cycle_index: 0,
            cycles: 4,
            category_id: None,
            event_id: None,
            finished_kind: None,
            finished_focused: 0,
            finished_completed: false,
            study_secs: 25 * 60,
            break_secs: 5 * 60,
            extend_study_secs: 5 * 60,
            extend_break_secs: 60,
        }
    }
}

impl Engine {
    pub fn is_active(&self) -> bool {
        self.phase != Phase::Idle
    }

    fn apply_settings(&mut self, settings: &Value) {
        let get_i = |key: &str, fallback: i64| {
            settings
                .get(key)
                .and_then(|v| v.as_i64())
                .unwrap_or(fallback)
        };
        let get_b = |key: &str, fallback: bool| {
            settings
                .get(key)
                .and_then(|v| v.as_bool())
                .unwrap_or(fallback)
        };
        self.study_secs = get_i("studyMinutes", 25).max(1) * 60;
        self.break_secs = get_i("breakMinutes", 5).max(1) * 60;
        self.cycles = get_i("cycles", 4).max(1);
        self.extend_study_secs = get_i("extendStudyMinutes", 5).max(1) * 60;
        self.extend_break_secs = get_i("extendBreakMinutes", 1).max(1) * 60;
        self.auto_next = get_b("autoStartNext", false);
    }

    pub fn public_state(&self) -> Value {
        let remaining = if self.mode == Mode::CountUp {
            self.elapsed_secs
        } else {
            self.remaining.max(0)
        };
        json!({
            "phase": self.phase.as_str(),
            "mode": self.mode.as_str(),
            "paused": self.paused,
            "pending": self.pending,
            "remaining": remaining,
            "elapsedSeconds": self.elapsed_secs,
            "planned": self.planned,
            "extended": self.extended,
            "extendedCount": self.extended_count,
            "totalSeconds": self.planned + self.extended,
            "cycleIndex": self.cycle_index,
            "cycles": self.cycles,
            "categoryId": self.category_id,
            "eventId": self.event_id,
            "pausedSeconds": self.paused_ms / 1000,
            "studySeconds": self.study_secs,
            "breakSeconds": self.break_secs,
            "autoNext": self.auto_next,
            "endAt": self.deadline_epoch.unwrap_or(0),
            "phaseStartedAt": self.phase_start_ms,
        })
    }

    fn update_elapsed(&mut self) {
        if self.mode != Mode::CountUp {
            return;
        }
        let elapsed_ms = (now_ms() - self.phase_start_ms).max(0) - self.paused_ms;
        self.elapsed_secs = (elapsed_ms / 1000).max(0);
    }

    fn recompute_remaining(&mut self) {
        if self.paused || self.pending {
            return;
        }
        if let Some(dl) = self.deadline {
            self.remaining = secs_display(dl.saturating_duration_since(Instant::now()));
        }
    }

    fn begin_study(
        &mut self,
        store: &Store,
        mode: Mode,
        category_id: Option<String>,
        event_id: Option<String>,
        planned: i64,
    ) {
        let settings = store.effective_settings(category_id.as_deref(), event_id.as_deref());
        self.apply_settings(&settings);
        self.mode = mode;
        self.phase = Phase::Study;
        self.paused = false;
        self.pending = false;
        self.planned = planned;
        self.extended = 0;
        self.extended_count = 0;
        self.remaining = planned;
        self.elapsed_secs = 0;
        self.paused_ms = 0;
        self.pause_started = None;
        self.cycle_index = 0;
        self.category_id = category_id;
        self.event_id = event_id;
        self.phase_start_ms = now_ms();
        self.finished_kind = None;
        self.finished_focused = 0;
        self.finished_completed = false;
        self.deadline = if mode == Mode::CountUp || planned <= 0 {
            None
        } else {
            Some(Instant::now() + Duration::from_secs(planned as u64))
        };
        self.deadline_epoch = if mode == Mode::CountUp || planned <= 0 {
            None
        } else {
            Some(now_ms() + planned * 1000)
        };
    }

    pub fn start(
        &mut self,
        store: &Store,
        category_id: Option<String>,
        event_id: Option<String>,
    ) {
        let study_secs = store.effective_settings(
            category_id.as_deref(),
            event_id.as_deref(),
        )["studyMinutes"]
            .as_i64()
            .unwrap_or(25)
            .max(1)
            * 60;
        self.begin_study(store, Mode::Pomodoro, category_id, event_id, study_secs);
    }

    pub fn start_countup(
        &mut self,
        store: &Store,
        category_id: Option<String>,
        event_id: Option<String>,
    ) {
        self.begin_study(store, Mode::CountUp, category_id, event_id, 0);
    }

    pub fn start_countdown(
        &mut self,
        store: &Store,
        category_id: Option<String>,
        event_id: Option<String>,
        minutes: i64,
    ) {
        let secs = minutes.max(1) * 60;
        self.begin_study(store, Mode::CountDown, category_id, event_id, secs);
    }

    pub fn tick(&mut self) -> Option<Value> {
        if self.phase == Phase::Idle || self.pending || self.paused {
            return None;
        }
        if self.mode == Mode::CountUp {
            self.update_elapsed();
            return None;
        }
        self.recompute_remaining();
        if self.remaining <= 0 {
            self.finish(true);
            return Some(self.finished_payload());
        }
        None
    }

    fn finish(&mut self, natural: bool) {
        let focused = if self.mode == Mode::CountUp {
            self.update_elapsed();
            self.elapsed_secs
        } else if natural {
            self.planned + self.extended
        } else {
            (self.planned + self.extended - self.remaining).max(0)
        };
        self.finished_kind = Some(self.phase);
        self.finished_focused = focused;
        self.finished_completed = natural;
        self.pending = true;
        self.paused = false;
        self.remaining = 0;
        self.deadline = None;
        self.deadline_epoch = None;
    }

    fn finished_payload(&self) -> Value {
        json!({
            "kind": self.finished_kind.unwrap_or(self.phase).as_str(),
            "mode": self.mode.as_str(),
            "completed": self.finished_completed,
            "focusedSeconds": self.finished_focused,
            "plannedSeconds": self.planned,
            "extendedSeconds": self.extended,
            "extendedCount": self.extended_count,
            "cycleIndex": self.cycle_index,
            "cycles": self.cycles,
            "categoryId": self.category_id,
            "eventId": self.event_id,
            "autoNext": self.auto_next,
        })
    }

    pub fn pause(&mut self) {
        if self.phase == Phase::Idle || self.paused || self.pending {
            return;
        }
        self.recompute_remaining();
        self.paused = true;
        self.deadline = None;
        self.deadline_epoch = None;
        self.pause_started = Some(Instant::now());
    }

    pub fn resume(&mut self) {
        if !self.paused {
            return;
        }
        if let Some(ps) = self.pause_started.take() {
            self.paused_ms += ps.elapsed().as_millis() as i64;
        }
        self.paused = false;
        self.deadline = Some(Instant::now() + Duration::from_secs(self.remaining.max(0) as u64));
        self.deadline_epoch = Some(now_ms() + self.remaining.max(0) * 1000);
    }

    pub fn extend_study(&mut self) -> bool {
        if self.phase != Phase::Study || self.mode == Mode::CountUp {
            return false;
        }
        if self.pending {
            self.pending = false;
            self.remaining = 0;
        }
        let add = self.extend_study_secs;
        self.extended += add;
        self.extended_count += 1;
        self.remaining += add;
        if !self.paused {
            self.deadline = Some(Instant::now() + Duration::from_secs(self.remaining as u64));
            self.deadline_epoch = Some(now_ms() + self.remaining * 1000);
        }
        self.extended > self.extend_study_secs
    }

    pub fn extend_break(&mut self) {
        if self.phase != Phase::Break {
            return;
        }
        if self.pending {
            self.pending = false;
            self.remaining = 0;
        }
        let add = self.extend_break_secs;
        self.extended += add;
        self.extended_count += 1;
        self.remaining += add;
        if !self.paused {
            self.deadline = Some(Instant::now() + Duration::from_secs(self.remaining as u64));
            self.deadline_epoch = Some(now_ms() + self.remaining * 1000);
        }
    }

    pub fn early_end(&mut self) -> Option<Value> {
        if self.phase == Phase::Idle || self.pending {
            return None;
        }
        self.finish(false);
        Some(self.finished_payload())
    }

    fn session_value(&self, kind: Phase, completed: bool, focused: i64) -> Value {
        json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "kind": kind.as_str(),
            "categoryId": self.category_id,
            "eventId": self.event_id,
            "startedAt": self.phase_start_ms,
            "endedAt": now_ms(),
            "plannedSeconds": self.planned,
            "focusedSeconds": focused,
            "pausedSeconds": self.paused_ms / 1000,
            "extendedSeconds": self.extended,
            "extendedCount": self.extended_count,
            "completed": completed,
        })
    }

    pub fn start_break(&mut self) -> Option<Value> {
        if self.phase != Phase::Study || !self.pending {
            return None;
        }
        let session = self.session_value(
            self.finished_kind.unwrap_or(Phase::Study),
            self.finished_completed,
            self.finished_focused,
        );
        self.begin_phase(Phase::Break, self.break_secs);
        Some(session)
    }

    pub fn next_study(&mut self) -> Option<Value> {
        if self.phase != Phase::Break || !self.pending {
            return None;
        }
        let session = self.session_value(
            self.finished_kind.unwrap_or(Phase::Break),
            self.finished_completed,
            self.finished_focused,
        );
        self.cycle_index += 1;
        if self.cycle_index >= self.cycles {
            self.reset_idle();
        } else {
            self.begin_phase(Phase::Study, self.study_secs);
        }
        Some(session)
    }

    pub fn flush_session(&mut self) -> Option<Value> {
        if self.phase == Phase::Idle {
            return None;
        }
        let value = if self.pending {
            self.session_value(
                self.finished_kind.unwrap_or(self.phase),
                self.finished_completed,
                self.finished_focused,
            )
        } else if self.mode == Mode::CountUp {
            self.update_elapsed();
            self.session_value(self.phase, false, self.elapsed_secs)
        } else {
            if !self.paused {
                self.recompute_remaining();
            }
            let focused = (self.planned + self.extended - self.remaining).max(0);
            self.session_value(self.phase, false, focused)
        };
        self.reset_idle();
        Some(value)
    }

    fn begin_phase(&mut self, phase: Phase, planned: i64) {
        self.phase = phase;
        self.paused = false;
        self.pending = false;
        self.planned = planned;
        self.extended = 0;
        self.extended_count = 0;
        self.remaining = planned;
        self.paused_ms = 0;
        self.pause_started = None;
        self.phase_start_ms = now_ms();
        self.finished_kind = None;
        self.finished_focused = 0;
        self.finished_completed = false;
        self.deadline = Some(Instant::now() + Duration::from_secs(planned as u64));
        self.deadline_epoch = Some(now_ms() + planned * 1000);
    }

    fn reset_idle(&mut self) {
        self.phase = Phase::Idle;
        self.paused = false;
        self.pending = false;
        self.deadline = None;
        self.deadline_epoch = None;
        self.remaining = 0;
        self.planned = 0;
        self.extended = 0;
        self.extended_count = 0;
        self.paused_ms = 0;
        self.pause_started = None;
        self.cycle_index = 0;
        self.category_id = None;
        self.event_id = None;
        self.finished_kind = None;
        self.finished_focused = 0;
        self.finished_completed = false;
    }

    /// 写入 `timer-snapshot.json` 的完整计时状态，用于进程被杀后恢复。
    pub fn snapshot(&self) -> Value {
        json!({
            "phase": self.phase.as_str(),
            "mode": self.mode.as_str(),
            "paused": self.paused,
            "pending": self.pending,
            "remaining": self.remaining,
            "elapsedSeconds": self.elapsed_secs,
            "planned": self.planned,
            "extended": self.extended,
            "extendedCount": self.extended_count,
            "pausedMs": self.paused_ms,
            "cycleIndex": self.cycle_index,
            "cycles": self.cycles,
            "categoryId": self.category_id,
            "eventId": self.event_id,
            "phaseStartedAt": self.phase_start_ms,
            "endAt": self.deadline_epoch.unwrap_or(0),
            "finishedKind": self.finished_kind.map(|k| k.as_str()),
            "finishedFocused": self.finished_focused,
            "finishedCompleted": self.finished_completed,
        })
    }

    /// 从快照恢复计时状态。已到期时回到 pending，等待用户选择下一阶段。
    pub fn restore(snapshot: &Value, store: &Store) -> Option<Engine> {
        let phase = match snapshot.get("phase").and_then(|v| v.as_str())? {
            "study" => Phase::Study,
            "break" => Phase::Break,
            _ => return None,
        };
        let mode = match snapshot.get("mode").and_then(|v| v.as_str()).unwrap_or("pomodoro") {
            "countup" => Mode::CountUp,
            "countdown" => Mode::CountDown,
            _ => Mode::Pomodoro,
        };

        let mut engine = Engine::default();
        engine.phase = phase;
        engine.mode = mode;
        engine.paused = snapshot["paused"].as_bool().unwrap_or(false);
        engine.pending = snapshot["pending"].as_bool().unwrap_or(false);
        engine.remaining = snapshot["remaining"].as_i64().unwrap_or(0);
        engine.elapsed_secs = snapshot["elapsedSeconds"].as_i64().unwrap_or(0);
        engine.planned = snapshot["planned"].as_i64().unwrap_or(0);
        engine.extended = snapshot["extended"].as_i64().unwrap_or(0);
        engine.extended_count = snapshot["extendedCount"].as_i64().unwrap_or(0);
        engine.paused_ms = snapshot["pausedMs"].as_i64().unwrap_or(0);
        engine.cycle_index = snapshot["cycleIndex"].as_i64().unwrap_or(0);
        engine.cycles = snapshot["cycles"].as_i64().unwrap_or(4).max(1);
        engine.category_id = snapshot["categoryId"].as_str().map(str::to_string);
        engine.event_id = snapshot["eventId"].as_str().map(str::to_string);
        engine.phase_start_ms = snapshot["phaseStartedAt"].as_i64().unwrap_or_else(now_ms);
        engine.finished_kind = match snapshot["finishedKind"].as_str() {
            Some("break") => Some(Phase::Break),
            Some("study") => Some(Phase::Study),
            _ => None,
        };
        engine.finished_focused = snapshot["finishedFocused"].as_i64().unwrap_or(0);
        engine.finished_completed = snapshot["finishedCompleted"].as_bool().unwrap_or(false);

        let settings = store.effective_settings(engine.category_id.as_deref(), engine.event_id.as_deref());
        engine.apply_settings(&settings);
        engine.cycles = snapshot["cycles"].as_i64().unwrap_or(engine.cycles).max(1);

        if engine.pending {
            engine.remaining = 0;
            engine.paused = false;
            engine.deadline = None;
            engine.deadline_epoch = None;
            return Some(engine);
        }

        if engine.mode == Mode::CountUp {
            engine.deadline = None;
            engine.deadline_epoch = None;
            if engine.paused {
                engine.pause_started = Some(Instant::now());
            } else {
                engine.update_elapsed();
            }
            return Some(engine);
        }

        if engine.paused {
            engine.deadline = None;
            engine.deadline_epoch = None;
            engine.pause_started = Some(Instant::now());
            return Some(engine);
        }

        if let Some(end_at) = snapshot["endAt"].as_i64().filter(|value| *value > 0) {
            let now = now_ms();
            if end_at <= now {
                engine.finish(true);
            } else {
                let remaining = (end_at - now + 999) / 1000;
                engine.remaining = remaining;
                engine.deadline = Some(Instant::now() + Duration::from_secs(remaining as u64));
                engine.deadline_epoch = Some(end_at);
            }
        } else if engine.remaining > 0 {
            engine.deadline = Some(Instant::now() + Duration::from_secs(engine.remaining as u64));
            engine.deadline_epoch = Some(now_ms() + engine.remaining * 1000);
        } else {
            engine.finish(true);
        }

        Some(engine)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{default_data, Store};
    use std::path::PathBuf;

    fn test_store() -> Store {
        Store {
            dir: PathBuf::from("."),
            file: PathBuf::from("test.json"),
            data: default_data(),
        }
    }

    #[test]
    fn start_enters_study_with_configured_duration() {
        let store = test_store();
        let mut e = Engine::default();
        e.start(&store, Some("study".into()), Some("e1".into()));
        assert_eq!(e.phase, Phase::Study);
        assert_eq!(e.remaining, 25 * 60);
        assert!(!e.pending);
        assert!(e.deadline.is_some());
    }

    #[test]
    fn extend_study_warns_only_after_exceeding_default() {
        let store = test_store();
        let mut e = Engine::default();
        e.start(&store, None, None);
        assert!(!e.extend_study());
        assert!(e.extend_study());
        assert_eq!(e.extended, 10 * 60);
        assert_eq!(e.extended_count, 2);
    }

    #[test]
    fn early_end_records_focused_and_pending() {
        let store = test_store();
        let mut e = Engine::default();
        e.start(&store, None, None);
        e.remaining = 20 * 60;
        let fin = e.early_end().unwrap();
        assert!(e.pending);
        assert_eq!(fin["focusedSeconds"].as_i64(), Some(5 * 60));
        assert_eq!(fin["completed"].as_bool(), Some(false));
        assert_eq!(fin["kind"].as_str(), Some("study"));
    }

    #[test]
    fn start_break_records_study_session() {
        let store = test_store();
        let mut e = Engine::default();
        e.start(&store, None, None);
        e.remaining = 0;
        e.finish(true);
        let session = e.start_break().unwrap();
        assert_eq!(session["kind"].as_str(), Some("study"));
        assert_eq!(session["focusedSeconds"].as_i64(), Some(25 * 60));
        assert_eq!(session["completed"].as_bool(), Some(true));
        assert_eq!(e.phase, Phase::Break);
        assert_eq!(e.remaining, 5 * 60);
    }

    #[test]
    fn full_cycle_returns_to_idle_after_configured_rounds() {
        let store = test_store();
        let mut e = Engine::default();
        e.start(&store, None, None);
        for i in 0..4 {
            e.remaining = 0;
            e.finish(true);
            e.start_break();
            e.remaining = 0;
            e.finish(true);
            let session = e.next_study();
            assert!(session.is_some());
            if i == 3 {
                assert_eq!(e.phase, Phase::Idle);
                assert_eq!(e.cycle_index, 0);
            } else {
                assert_eq!(e.phase, Phase::Study);
            }
        }
    }

    #[test]
    fn pause_clears_deadline_and_resume_restores_it() {
        let store = test_store();
        let mut e = Engine::default();
        e.start(&store, None, None);
        e.pause();
        assert!(e.paused);
        assert!(e.deadline.is_none());
        e.resume();
        assert!(!e.paused);
        assert!(e.deadline.is_some());
    }

    #[test]
    fn extend_after_finish_resumes_study() {
        let store = test_store();
        let mut e = Engine::default();
        e.start(&store, None, None);
        e.remaining = 0;
        e.finish(true);
        assert!(e.pending);
        e.extend_study();
        assert!(!e.pending);
        assert_eq!(e.remaining, 5 * 60);
    }

    #[test]
    fn snapshot_restore_keeps_running_countdown() {
        let store = test_store();
        let mut e = Engine::default();
        e.start_countdown(&store, Some("study".into()), Some("e1".into()), 5);
        let snapshot = e.snapshot();
        let restored = Engine::restore(&snapshot, &store).expect("restore");
        assert_eq!(restored.phase, Phase::Study);
        assert_eq!(restored.mode, Mode::CountDown);
        assert!(!restored.paused);
        assert!(!restored.pending);
        assert!(restored.remaining > 0);
        assert!(restored.remaining <= 5 * 60);
    }

    #[test]
    fn snapshot_restore_paused_preserves_remaining() {
        let store = test_store();
        let mut e = Engine::default();
        e.start(&store, None, None);
        e.pause();
        e.remaining = 123;
        let snapshot = e.snapshot();
        let restored = Engine::restore(&snapshot, &store).expect("restore");
        assert!(restored.paused);
        assert_eq!(restored.remaining, 123);
        assert!(restored.pause_started.is_some());
    }

    #[test]
    fn snapshot_restore_expired_countdown_becomes_pending() {
        let store = test_store();
        let mut e = Engine::default();
        e.start_countdown(&store, None, None, 1);
        let mut snapshot = e.snapshot();
        snapshot["endAt"] = json!(now_ms() - 1000);
        let restored = Engine::restore(&snapshot, &store).expect("restore");
        assert!(restored.pending);
        assert_eq!(restored.remaining, 0);
        assert_eq!(restored.phase, Phase::Study);
    }
}
