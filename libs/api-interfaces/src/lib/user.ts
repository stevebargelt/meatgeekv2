/**
 * User account information
 */
export interface User {
  id: string;
  email: string;
  name: string;
  preferences: UserPreferences;
  devices: string[]; // Array of device IDs
  createdAt: string;
  lastLogin?: string;
  subscription?: {
    plan: 'free' | 'premium' | 'pro';
    status: 'active' | 'cancelled' | 'expired';
    expiresAt?: string;
  };
}

/**
 * User preferences and settings
 */
export interface UserPreferences {
  temperatureUnit: 'fahrenheit' | 'celsius';
  timeZone: string;
  notifications: NotificationPreferences;
  defaultTargetTemps: Record<string, TargetTemps>;
  privacy: {
    shareData: boolean;
    publicProfile: boolean;
    allowAnalytics: boolean;
  };
  display: {
    theme: 'light' | 'dark' | 'auto';
    compactMode: boolean;
    showAdvancedMetrics: boolean;
  };
}

/**
 * Target temperatures for different meat types
 */
interface TargetTemps {
  grill: number;
  meat: number;
}

/**
 * Notification preferences
 */
export interface NotificationPreferences {
  tempAlerts: boolean;
  cookComplete: boolean;
  deviceOffline: boolean;
  weeklyReports: boolean;
  productUpdates: boolean;
  pushNotifications: {
    enabled: boolean;
    sound: boolean;
    vibration: boolean;
    quietHours: {
      enabled: boolean;
      startTime: string; // HH:MM
      endTime: string; // HH:MM
    };
  };
  email: {
    enabled: boolean;
    frequency: 'immediate' | 'hourly' | 'daily';
  };
  sms: {
    enabled: boolean;
    phoneNumber?: string;
  };
}

/**
 * User registration request
 */
export interface RegisterUserRequest {
  email: string;
  password: string;
  name: string;
  preferences?: Partial<UserPreferences>;
}

/**
 * User login request
 */
export interface LoginRequest {
  email: string;
  password: string;
  rememberMe?: boolean;
}

/**
 * User authentication response
 */
export interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

/**
 * Update user profile request
 */
export interface UpdateUserRequest {
  name?: string;
  preferences?: Partial<UserPreferences>;
}

/**
 * Change password request
 */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/**
 * Password reset request
 */
export interface ResetPasswordRequest {
  email: string;
}

/**
 * User activity summary
 */
export interface UserActivity {
  userId: string;
  totalCooks: number;
  totalCookTime: number; // hours
  averageCookDuration: number; // hours
  favoriteMetType?: string;
  recentCooks: Array<{
    cookId: string;
    name: string;
    startTime: string;
    duration: number; // hours
    meatType: string;
  }>;
  achievements: Achievement[];
}

/**
 * User achievement/badge
 */
export interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  unlockedAt: string;
  category: 'cooking' | 'duration' | 'consistency' | 'exploration';
}