#!/bin/bash
#
# 材料(/events)の取込(src/loadEventCalendar.js)の cron 実行用ラッパー
#
# 時刻は取得元ごとの更新の時刻(src/eventSchedule.js)から決めた。日本時間で毎日2回(7:30 は冬時間の先物の引け 7:00 に重ならないように。2026-10-25):
#   7:30  … 米国の前日の引けの分(先物・指数・期待インフレ率)と SEC の提出書類
#   14:00 … 日本の金利(財務省は翌営業日 9:30頃)と FINRA の前日(米国の日付)の分
# 毎回14日前から取り直すので、遅れて出る値(米2年・10年金利、ハイイールド債)も次の回で入る。
# 土日も回す(米国の金曜の分が日本の土曜の朝に出るため)。
#
# crontab の設定(VM の時刻帯によらず日本時間で動かすため CRON_TZ を付ける):
#   CRON_TZ=Asia/Tokyo
#   30 7 * * * /opt/jquants-batch/scripts/run-events.sh
#   0 14 * * * /opt/jquants-batch/scripts/run-events.sh
#
# 必要な .env: JQB_SEC_USER_AGENT(SEC は名前とメールアドレスが必須)

set -uo pipefail

APP_DIR="/opt/jquants-batch"
LOG_DIR="${APP_DIR}/logs"
LOG_RETENTION_DAYS=60

export PATH="/usr/local/bin:/usr/bin:/bin:${PATH}"

mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/events_$(date +%Y%m%d).log"

cd "${APP_DIR}" || {
  echo "アプリケーションディレクトリが見つかりません: ${APP_DIR}" >&2
  exit 1
}

# 前の回がまだ動いていたら重ねて動かさない
exec 9>"${LOG_DIR}/events.lock"
if ! flock -n 9; then
  echo "前の回の材料の取込がまだ動いているので飛ばしました" >> "${LOG_FILE}"
  exit 0
fi

{
  echo "===================================================="
  echo "開始: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "===================================================="
} >> "${LOG_FILE}"

node src/loadEventCalendar.js >> "${LOG_FILE}" 2>&1
EXIT_CODE=$?

{
  echo "----------------------------------------------------"
  echo "終了: $(date '+%Y-%m-%d %H:%M:%S %Z') (exit=${EXIT_CODE})"
  echo ""
} >> "${LOG_FILE}"

find "${LOG_DIR}" -name 'events_*.log' -type f -mtime "+${LOG_RETENTION_DAYS}" -delete 2>/dev/null

# 成功時は何も出さない(cron の MAILTO で失敗時だけ通知されるように。run-daily.sh と同じ)
if [ ${EXIT_CODE} -ne 0 ]; then
  echo "jquants-batch 材料の取込が失敗しました (exit=${EXIT_CODE})" >&2
  echo "ログ: ${LOG_FILE}" >&2
  tail -n 30 "${LOG_FILE}" >&2
fi

exit ${EXIT_CODE}
