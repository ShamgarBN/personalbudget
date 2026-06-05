mod db;
mod error;
mod models;
mod merchant;
mod pay_period;
mod parsers;
mod forecast;
mod commands;

use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::Manager;

pub struct AppState {
    pub conn: Arc<Mutex<Connection>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("could not resolve app data dir");
            std::fs::create_dir_all(&app_data_dir)?;
            let db_path = app_data_dir.join("budget.sqlite3");
            log::info!("Opening database at {}", db_path.display());

            let mut conn = db::open(&db_path)?;
            db::run_migrations(&mut conn)?;
            db::seed_if_empty(&conn)?;

            app.manage(AppState {
                conn: Arc::new(Mutex::new(conn)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::accounts::list_accounts,
            commands::accounts::create_account,
            commands::accounts::update_account,
            commands::accounts::account_balance_as_of,
            commands::categories::list_categories,
            commands::categories::create_category,
            commands::categories::update_category,
            commands::categories::delete_category,
            commands::transactions::list_transactions,
            commands::transactions::create_transaction,
            commands::transactions::update_transaction,
            commands::transactions::delete_transaction,
            commands::transactions::mark_reviewed,
            commands::transactions::simplify_descriptions,
            commands::transactions::split_transaction,
            commands::transactions::unsplit_transaction,
            commands::transactions::get_transaction,
            commands::pay_periods::list_pay_period_schedules,
            commands::pay_periods::upsert_pay_period_schedule,
            commands::pay_periods::delete_pay_period_schedule,
            commands::pay_periods::generate_pay_periods,
            commands::imp::preview_import,
            commands::imp::commit_import,
            commands::imp::list_import_batches,
            commands::imp::undo_import_batch,
            commands::legacy_import::preview_legacy_import,
            commands::legacy_import::commit_legacy_import,
            commands::dashboard::dashboard_summary,
            commands::dashboard::cash_flow_monthly,
            commands::dashboard::net_worth_monthly,
            commands::dashboard::category_drift,
            commands::backup::create_backup,
            commands::backup::list_backups,
            commands::backup::restore_backup,
            commands::export::export_json,
            commands::budgets::list_budget_allocations,
            commands::budgets::upsert_budget_allocation,
            commands::budgets::delete_budget_allocation,
            commands::budgets::budget_summary,
            commands::bills::list_recurring_bills,
            commands::bills::upsert_recurring_bill,
            commands::bills::delete_recurring_bill,
            commands::goals::list_goals,
            commands::goals::upsert_goal,
            commands::goals::delete_goal,
            commands::forecast_cmd::run_forecast,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
