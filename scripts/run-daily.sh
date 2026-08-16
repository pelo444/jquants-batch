#!/bin/bash
#
# 日次投入バッチのcron実行用ラッパー
#
# cronはPATHや環境変数が対話シェルと異なるため、明示的に設定してから実行する。
# ログはlogs/配下に日付別に出力し、古いものは自動削除する。
#
# crontabの設定例(平日の18:30に実行):
#   30 18 * * 1-5 /opt/jquants-batch/scripts/run-daily.sh
#
# ※ J-Quantsの当日データは17:30頃以降に利用可能になるため、
#   余裕を見て18:30以降を推奨。

set -uo pipefail

APP_DIR="/opt/jquants-batch"
LOG_DIR="${APP_DIR}/logs"
LOG_RETENTION_DAYS=60

# --- Node.jsのパスを明示する(cronではPATHが最小限のため) ---
# nvm等を使っている場合は、実際のnodeのパスに合わせて修正すること
# 確認方法: which node
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH}"

mkdir -p "${LOG_DIR}"

LOG_FILE="${LOG_DIR}/daily_$(date +%Y%m%d).log"

cd "${APP_DIR}" || {
  echo "アプリケーションディレクトリが見つかりません: ${APP_DIR}" >&2
  exit 1
}

{
  echo "===================================================="
  echo "開始: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "===================================================="
} >> "${LOG_FILE}"

node src/loadDaily.js >> "${LOG_FILE}" 2>&1
EXIT_CODE=$?

{
  echo "----------------------------------------------------"
  echo "終了: $(date '+%Y-%m-%d %H:%M:%S') (exit=${EXIT_CODE})"
  echo ""
} >> "${LOG_FILE}"

# --- 古いログの削除 ---
find "${LOG_DIR}" -name 'daily_*.log' -type f -mtime "+${LOG_RETENTION_DAYS}" -delete 2>/dev/null

# --- 失敗時は標準エラーに出力する ---
# cronはコマンドが標準出力/標準エラーに何か出力するとMAILTO宛にメールを送るため、
# 成功時は何も出力せず、失敗時のみ通知されるようにする。
if [ ${EXIT_CODE} -ne 0 ]; then
  echo "jquants-batch 日次投入が失敗しました (exit=${EXIT_CODE})" >&2
  echo "ログ: ${LOG_FILE}" >&2
  # 原因が分かるよう、ログの末尾も通知内容に含める
  tail -n 30 "${LOG_FILE}" >&2
fi

exit ${EXIT_CODE}
