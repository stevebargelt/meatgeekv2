/**
 * Data validation utilities and business rules
 */

import { VALIDATION, MEAT_TYPES } from '@meatgeekv2/utils';
import { 
  StartCookRequest, 
  UpdateCookRequest, 
  RegisterDeviceRequest,
  RegisterUserRequest 
} from '@meatgeekv2/api-interfaces';

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings?: string[];
}

export class DataValidator {
  /**
   * Validates temperature value
   */
  static validateTemperature(temperature: number | null | undefined): ValidationResult {
    const errors: string[] = [];

    if (temperature === null || temperature === undefined) {
      return { isValid: true, errors: [] }; // Null temperatures are allowed
    }

    if (isNaN(temperature)) {
      errors.push('Temperature must be a valid number');
    } else {
      if (temperature < VALIDATION.TEMPERATURE.MIN) {
        errors.push(`Temperature must be at least ${VALIDATION.TEMPERATURE.MIN}°F`);
      }
      if (temperature > VALIDATION.TEMPERATURE.MAX) {
        errors.push(`Temperature cannot exceed ${VALIDATION.TEMPERATURE.MAX}°F`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validates cook start request
   */
  static validateStartCookRequest(request: StartCookRequest): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate required fields
    if (!request.name || request.name.trim().length === 0) {
      errors.push('Cook name is required');
    } else {
      if (request.name.length < VALIDATION.COOK_NAME.MIN_LENGTH) {
        errors.push(`Cook name must be at least ${VALIDATION.COOK_NAME.MIN_LENGTH} characters`);
      }
      if (request.name.length > VALIDATION.COOK_NAME.MAX_LENGTH) {
        errors.push(`Cook name cannot exceed ${VALIDATION.COOK_NAME.MAX_LENGTH} characters`);
      }
    }

    if (!request.deviceId || request.deviceId.trim().length === 0) {
      errors.push('Device ID is required');
    }

    if (!request.meatType || request.meatType.trim().length === 0) {
      errors.push('Meat type is required');
    } else {
      const meatTypeExists = Object.values(MEAT_TYPES).some(
        mt => mt.name.toLowerCase() === request.meatType.toLowerCase()
      );
      if (!meatTypeExists) {
        warnings.push(`'${request.meatType}' is not a recognized meat type`);
      }
    }

    // Validate optional fields
    if (request.weight !== undefined) {
      if (request.weight <= 0) {
        errors.push('Weight must be greater than 0');
      }
      if (request.weight > 50) {
        warnings.push('Weight over 50 pounds - verify this is correct');
      }
    }

    // Validate target temperatures
    if (request.targetTemps) {
      const tempValidation = this.validateTargetTemperatures(request.targetTemps);
      errors.push(...tempValidation.errors);
      warnings.push(...(tempValidation.warnings || []));
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validates cook update request
   */
  static validateUpdateCookRequest(request: UpdateCookRequest): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (request.name !== undefined) {
      if (request.name.length < VALIDATION.COOK_NAME.MIN_LENGTH) {
        errors.push(`Cook name must be at least ${VALIDATION.COOK_NAME.MIN_LENGTH} characters`);
      }
      if (request.name.length > VALIDATION.COOK_NAME.MAX_LENGTH) {
        errors.push(`Cook name cannot exceed ${VALIDATION.COOK_NAME.MAX_LENGTH} characters`);
      }
    }

    if (request.rating !== undefined) {
      if (request.rating < 1 || request.rating > 5) {
        errors.push('Rating must be between 1 and 5 stars');
      }
    }

    if (request.targetTemps) {
      const tempValidation = this.validateTargetTemperatures(request.targetTemps);
      errors.push(...tempValidation.errors);
      warnings.push(...(tempValidation.warnings || []));
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validates target temperature configuration
   */
  static validateTargetTemperatures(targetTemps: {
    grill?: number;
    probe1?: number;
    probe2?: number;
    probe3?: number;
    probe4?: number;
  }): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate grill temperature
    if (targetTemps.grill !== undefined) {
      if (targetTemps.grill < 150 || targetTemps.grill > 500) {
        errors.push('Grill temperature must be between 150°F and 500°F');
      }
    }

    // Validate probe temperatures
    (['probe1', 'probe2', 'probe3', 'probe4'] as const).forEach(probe => {
      const temp = targetTemps[probe];
      if (temp !== undefined) {
        if (temp < 100 || temp > 250) {
          errors.push(`${probe} temperature must be between 100°F and 250°F`);
        }
        
        // Warning for potentially unsafe temperatures
        if (temp < 140) {
          warnings.push(`${probe} temperature of ${temp}°F may not be safe for all meats`);
        }
      }
    });

    // Validate logical relationships
    if (targetTemps.grill && targetTemps.probe1) {
      if (targetTemps.probe1 > targetTemps.grill + 50) {
        warnings.push('Meat target temperature is significantly higher than grill temperature');
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validates device registration
   */
  static validateDeviceRegistration(request: RegisterDeviceRequest): ValidationResult {
    const errors: string[] = [];

    if (!request.deviceId || request.deviceId.trim().length === 0) {
      errors.push('Device ID is required');
    } else {
      if (request.deviceId.length < 3) {
        errors.push('Device ID must be at least 3 characters');
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(request.deviceId)) {
        errors.push('Device ID can only contain letters, numbers, underscores, and hyphens');
      }
    }

    if (!request.name || request.name.trim().length === 0) {
      errors.push('Device name is required');
    } else {
      if (request.name.length < VALIDATION.DEVICE_NAME.MIN_LENGTH) {
        errors.push(`Device name must be at least ${VALIDATION.DEVICE_NAME.MIN_LENGTH} characters`);
      }
      if (request.name.length > VALIDATION.DEVICE_NAME.MAX_LENGTH) {
        errors.push(`Device name cannot exceed ${VALIDATION.DEVICE_NAME.MAX_LENGTH} characters`);
      }
    }

    if (!request.model || request.model.trim().length === 0) {
      errors.push('Device model is required');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validates user registration
   */
  static validateUserRegistration(request: RegisterUserRequest): ValidationResult {
    const errors: string[] = [];

    // Email validation
    if (!request.email || !VALIDATION.EMAIL.PATTERN.test(request.email)) {
      errors.push('Valid email address is required');
    }

    // Password validation
    if (!request.password || request.password.length < 8) {
      errors.push('Password must be at least 8 characters');
    } else {
      if (!/(?=.*[a-z])/.test(request.password)) {
        errors.push('Password must contain at least one lowercase letter');
      }
      if (!/(?=.*[A-Z])/.test(request.password)) {
        errors.push('Password must contain at least one uppercase letter');
      }
      if (!/(?=.*\d)/.test(request.password)) {
        errors.push('Password must contain at least one number');
      }
    }

    // Name validation
    if (!request.name || request.name.trim().length < 2) {
      errors.push('Name must be at least 2 characters');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validates email format
   */
  static validateEmail(email: string): boolean {
    return VALIDATION.EMAIL.PATTERN.test(email);
  }

  /**
   * Validates phone number format (US)
   */
  static validatePhoneNumber(phone: string): boolean {
    const cleaned = phone.replace(/\D/g, '');
    return cleaned.length === 10;
  }

  /**
   * Sanitizes user input for security
   */
  static sanitizeString(input: string): string {
    return input
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove script tags
      .replace(/[<>'"]/g, '') // Remove HTML special characters
      .trim();
  }

  /**
   * Validates cook name for uniqueness within user's cooks
   */
  static validateCookNameUniqueness(
    cookName: string, 
    existingCooks: Array<{ name: string }>, 
    excludeCookId?: string
  ): ValidationResult {
    const errors: string[] = [];
    
    const isDuplicate = existingCooks
      .filter(cook => excludeCookId === undefined || cook.name !== excludeCookId)
      .some(cook => cook.name.toLowerCase() === cookName.toLowerCase());

    if (isDuplicate) {
      errors.push('A cook with this name already exists');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }
}