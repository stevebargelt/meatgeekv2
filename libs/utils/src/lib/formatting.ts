/**
 * General formatting utilities for display
 */

/**
 * Formats a number with specified decimal places
 */
export function formatNumber(value: number | null | undefined, decimals: number = 2): string {
  if (value === null || value === undefined || isNaN(value)) {
    return '--';
  }
  return value.toFixed(decimals);
}

/**
 * Formats file size in human readable format
 */
export function formatFileSize(bytes: number): string {
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  
  if (bytes === 0) {
    return '0 B';
  }
  
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  
  return `${size.toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`;
}

/**
 * Truncates text with ellipsis
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Capitalizes the first letter of each word
 */
export function titleCase(str: string): string {
  return str.replace(/\w\S*/g, (txt) => 
    txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
  );
}

/**
 * Converts camelCase to Title Case
 */
export function camelToTitle(str: string): string {
  return str
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (str) => str.toUpperCase())
    .trim();
}

/**
 * Formats percentage value
 */
export function formatPercentage(value: number, decimals: number = 1): string {
  return `${value.toFixed(decimals)}%`;
}

/**
 * Formats currency value
 */
export function formatCurrency(value: number, currency: string = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
  }).format(value);
}

/**
 * Formats a list with proper grammar (Oxford comma)
 */
export function formatList(items: string[]): string {
  if (items.length === 0) {
    return '';
  }
  if (items.length === 1) {
    return items[0];
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/**
 * Pluralizes a word based on count
 */
export function pluralize(count: number, singular: string, plural?: string): string {
  const word = count === 1 ? singular : (plural || singular + 's');
  return `${count} ${word}`;
}

/**
 * Formats phone number (US format)
 */
export function formatPhoneNumber(phone: string): string {
  const cleaned = phone.replace(/\D/g, '');
  
  if (cleaned.length === 10) {
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
  }
  
  return phone; // Return original if not 10 digits
}

/**
 * Formats email for display (truncate domain if too long)
 */
export function formatEmail(email: string, maxLength: number = 30): string {
  if (email.length <= maxLength) {
    return email;
  }
  
  const [user, domain] = email.split('@');
  if (user.length + 5 >= maxLength) { // 5 for @...
    return `${user.substring(0, maxLength - 8)}...@${domain}`;
  }
  
  return `${user}@...`;
}

/**
 * Formats a URL for display (remove protocol, truncate if needed)
 */
export function formatUrl(url: string, maxLength: number = 50): string {
  let formatted = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  
  if (formatted.length > maxLength) {
    formatted = formatted.substring(0, maxLength - 3) + '...';
  }
  
  return formatted;
}

/**
 * Formats cooking time estimate
 */
export function formatCookTimeEstimate(startTime: Date, targetTemp: number, currentTemp: number): string {
  const now = new Date();
  const elapsedMinutes = Math.floor((now.getTime() - startTime.getTime()) / (1000 * 60));
  
  if (currentTemp >= targetTemp) {
    return 'Done!';
  }
  
  if (elapsedMinutes < 30) {
    return 'Calculating...';
  }
  
  // Simple linear projection (could be enhanced with historical data)
  const tempRise = currentTemp - 70; // Assume starting temp around 70°F
  const tempNeeded = targetTemp - currentTemp;
  const ratePerMinute = tempRise / elapsedMinutes;
  
  if (ratePerMinute <= 0) {
    return 'Unable to estimate';
  }
  
  const estimatedMinutes = Math.ceil(tempNeeded / ratePerMinute);
  const estimatedCompletion = new Date(now.getTime() + estimatedMinutes * 60 * 1000);
  
  return `~${formatDuration(estimatedMinutes)} (${estimatedCompletion.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  })})`;
}

/**
 * Helper function for duration formatting (imported from date-utils concept)
 */
function formatDuration(minutes: number): string {
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