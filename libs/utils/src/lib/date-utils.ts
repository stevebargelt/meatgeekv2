/**
 * Date and time utilities for MeatGeek V2
 */

/**
 * Formats a date to ISO string in UTC
 */
export function toISOString(date: Date): string {
  return date.toISOString();
}

/**
 * Formats a date for display
 */
export function formatDate(date: Date | string, format: 'short' | 'long' | 'time' = 'short'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  
  switch (format) {
    case 'short':
      return d.toLocaleDateString();
    case 'long':
      return d.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    case 'time':
      return d.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
      });
    default:
      return d.toLocaleDateString();
  }
}

/**
 * Formats duration in minutes to human readable string
 */
export function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`;
  }
  
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  
  if (remainingMinutes === 0) {
    return `${hours}h`;
  }
  
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Calculates duration between two dates in minutes
 */
export function calculateDuration(startDate: Date | string, endDate: Date | string): number {
  const start = typeof startDate === 'string' ? new Date(startDate) : startDate;
  const end = typeof endDate === 'string' ? new Date(endDate) : endDate;
  
  return Math.floor((end.getTime() - start.getTime()) / (1000 * 60));
}

/**
 * Gets relative time string (e.g., "2 hours ago", "in 30 minutes")
 */
export function getRelativeTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  
  if (Math.abs(diffMinutes) < 1) {
    return 'just now';
  }
  
  if (diffMinutes > 0) {
    // Past
    if (diffMinutes < 60) {
      return `${diffMinutes}m ago`;
    }
    const hours = Math.floor(diffMinutes / 60);
    if (hours < 24) {
      return `${hours}h ago`;
    }
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } else {
    // Future
    const futureMinutes = Math.abs(diffMinutes);
    if (futureMinutes < 60) {
      return `in ${futureMinutes}m`;
    }
    const hours = Math.floor(futureMinutes / 60);
    if (hours < 24) {
      return `in ${hours}h`;
    }
    const days = Math.floor(hours / 24);
    return `in ${days}d`;
  }
}

/**
 * Checks if a date is today
 */
export function isToday(date: Date | string): boolean {
  const d = typeof date === 'string' ? new Date(date) : date;
  const today = new Date();
  
  return d.getDate() === today.getDate() &&
    d.getMonth() === today.getMonth() &&
    d.getFullYear() === today.getFullYear();
}

/**
 * Gets the start of day for a given date
 */
export function getStartOfDay(date: Date | string): Date {
  const d = typeof date === 'string' ? new Date(date) : new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Gets the end of day for a given date
 */
export function getEndOfDay(date: Date | string): Date {
  const d = typeof date === 'string' ? new Date(date) : new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}