export function sendNotification(userId: string, message: string) {
  if (!userId || !message) throw new Error('Missing required fields');
  return { userId, message, timestamp: Date.now(), read: false };
}
