const buildDateRangeMatch = (startDate, endDate, field = "createdAt") => {
  const range = {};

  if (startDate) {
    const start = new Date(startDate);
    if (!Number.isNaN(start.getTime())) {
      if (String(startDate).length <= 10) {
        start.setHours(0, 0, 0, 0);
      }
      range.$gte = start;
    }
  }

  if (endDate) {
    const end = new Date(endDate);
    if (!Number.isNaN(end.getTime())) {
      if (String(endDate).length <= 10) {
        end.setHours(23, 59, 59, 999);
      }
      range.$lte = end;
    }
  }

  return Object.keys(range).length ? { [field]: range } : {};
};

export { buildDateRangeMatch };
