const MAX_QUEUED_MESSAGES = 20;

export function createMessageQueue(limit = MAX_QUEUED_MESSAGES) {
  const entries = [];

  return {
    enqueue(entry) {
      if (entries.length >= limit) return false;
      entries.push({ ...entry });
      return true;
    },
    take() {
      return entries.shift() || null;
    },
    countFor(conversationId) {
      return entries.filter((entry) => entry.conversationId === conversationId).length;
    },
    get size() {
      return entries.length;
    },
  };
}
