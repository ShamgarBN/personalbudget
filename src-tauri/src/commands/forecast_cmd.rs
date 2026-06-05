use tauri::State;

use crate::error::AppResult;
use crate::forecast::{self, ForecastArgs, ForecastResult};
use crate::AppState;

#[tauri::command]
pub fn run_forecast(state: State<AppState>, args: ForecastArgs) -> AppResult<ForecastResult> {
    let conn = state.conn.lock();
    forecast::run(&conn, args)
}
