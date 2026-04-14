const recurrenceUnits = ['day', 'week', 'month']

const normalizeRecurrenceUnit = (value) => (recurrenceUnits.includes(value) ? value : 'week')

const normalizeRecurrenceInterval = (value) => {
  const interval = Number(value || 1)

  if (!Number.isFinite(interval) || interval < 1) {
    return 1
  }

  return Math.floor(interval)
}

const addRecurrenceInterval = (date, unit, interval) => {
  const nextDate = new Date(date)
  const step = normalizeRecurrenceInterval(interval)

  if (unit === 'day') {
    nextDate.setDate(nextDate.getDate() + step)
    return nextDate
  }

  if (unit === 'month') {
    nextDate.setMonth(nextDate.getMonth() + step)
    return nextDate
  }

  nextDate.setDate(nextDate.getDate() + step * 7)
  return nextDate
}

const buildNextRecurringRun = (campaign) => {
  if (!campaign?.isRecurring) {
    return null
  }

  const baseDate = campaign.scheduledAt || campaign.sentAt || new Date()
  const unit = normalizeRecurrenceUnit(campaign.recurrenceUnit)
  const interval = normalizeRecurrenceInterval(campaign.recurrenceInterval)
  const nextRunAt = addRecurrenceInterval(baseDate, unit, interval)
  const maxRuns = Number(campaign.recurrenceMaxRuns || 0)
  const nextRunCount = Number(campaign.recurrenceRunCount || 0) + 1

  if (maxRuns > 0 && nextRunCount >= maxRuns) {
    return null
  }

  return nextRunAt
}

export {
  buildNextRecurringRun,
  normalizeRecurrenceInterval,
  normalizeRecurrenceUnit,
  recurrenceUnits,
}
