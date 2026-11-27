use chrono::{Datelike, Local, NaiveDate};
use serde_json::Value;

use crate::storage::Store;

fn days_until(today: NaiveDate, target: NaiveDate, recurring: bool) -> i64 {
    if !recurring {
        return (target - today).num_days();
    }
    let this_year = NaiveDate::from_ymd_opt(today.year(), target.month(), target.day())
        .or_else(|| NaiveDate::from_ymd_opt(today.year(), target.month(), 28));
    let t = match this_year {
        Some(d) => d,
        None => return i64::MAX,
    };
    if t >= today {
        (t - today).num_days()
    } else {
        let next = NaiveDate::from_ymd_opt(today.year() + 1, target.month(), target.day())
            .or_else(|| NaiveDate::from_ymd_opt(today.year() + 1, target.month(), 28));
        match next {
            Some(d) => (d - today).num_days(),
            None => i64::MAX,
        }
    }
}

/// 检查是否有倒计时事件到达提醒日，返回需要提醒的事件列表。
pub fn check_due(store: &mut Store) -> Vec<Value> {
    let today = Local::now().date_naive();
    let today_str = today.format("%Y-%m-%d").to_string();

    let countdowns = store
        .data
        .get("countdowns")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut due: Vec<Value> = Vec::new();
    let mut updated: Vec<Value> = Vec::new();
    let mut changed = false;

    for mut item in countdowns {
        let date_str = item.get("date").and_then(|v| v.as_str()).unwrap_or("");
        let target = match NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
            Ok(d) => d,
            Err(_) => {
                updated.push(item);
                continue;
            }
        };
        let recurring =
            item.get("recurring").and_then(|v| v.as_str()).unwrap_or("none") == "yearly";
        let days = days_until(today, target, recurring);
        let remind = item
            .get("remindDaysBefore")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let last = item
            .get("lastNotifiedOn")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let should_remind = days == remind || days == 0;
        if should_remind && last != today_str {
            if let Some(obj) = item.as_object_mut() {
                obj.insert("lastNotifiedOn".into(), Value::String(today_str.clone()));
            }
            changed = true;
            due.push(item.clone());
        }
        updated.push(item);
    }

    if changed {
        if let Some(obj) = store.data.as_object_mut() {
            obj.insert("countdowns".into(), Value::Array(updated));
        }
        let _ = store.persist();
    }

    due
}
