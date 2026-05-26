/**
 * Temperature conversion and calculation utilities
 */

/**
 * Converts Celsius to Fahrenheit
 */
export function celsiusToFahrenheit(celsius: number): number {
  return (celsius * 9/5) + 32;
}

/**
 * Converts Fahrenheit to Celsius
 */
export function fahrenheitToCelsius(fahrenheit: number): number {
  return (fahrenheit - 32) * 5/9;
}

/**
 * Formats temperature with unit
 */
export function formatTemperature(
  temp: number | null | undefined, 
  unit: 'fahrenheit' | 'celsius' = 'fahrenheit',
  precision: number = 1
): string {
  if (temp === null || temp === undefined) {
    return '--°';
  }
  
  const symbol = unit === 'fahrenheit' ? 'F' : 'C';
  return `${temp.toFixed(precision)}°${symbol}`;
}

/**
 * Converts temperature to the specified unit
 */
export function convertTemperature(
  temp: number,
  fromUnit: 'fahrenheit' | 'celsius',
  toUnit: 'fahrenheit' | 'celsius'
): number {
  if (fromUnit === toUnit) {
    return temp;
  }
  
  if (fromUnit === 'celsius' && toUnit === 'fahrenheit') {
    return celsiusToFahrenheit(temp);
  }
  
  if (fromUnit === 'fahrenheit' && toUnit === 'celsius') {
    return fahrenheitToCelsius(temp);
  }
  
  return temp;
}

/**
 * RTD resistance to temperature conversion (Pt100/Pt1000)
 */
export function resistanceToTemperature(resistance: number, r0: number = 100): number {
  // Callendar-Van Dusen equation coefficients for Pt100
  const A = 3.9083e-3;
  const B = -5.775e-7;
  
  // Simplified calculation for positive temperatures
  const ratio = resistance / r0;
  const tempC = (-A + Math.sqrt(A * A - 4 * B * (1 - ratio))) / (2 * B);
  
  return celsiusToFahrenheit(tempC);
}

/**
 * ADC value to resistance conversion for MCP3008
 */
export function adcToResistance(adcValue: number, referenceVoltage: number = 3.3, referenceResistor: number = 10000): number {
  if (adcValue === 0) {
    return Infinity;
  }
  
  const voltage = (adcValue / 1023) * referenceVoltage;
  const current = (referenceVoltage - voltage) / referenceResistor;
  
  if (current === 0) {
    return Infinity;
  }
  
  return voltage / current;
}

/**
 * Temperature color coding for UI
 */
export function getTemperatureColor(temp: number | null, targetTemp?: number): string {
  if (temp === null || temp === undefined) {
    return '#6b7280'; // Gray for no data
  }
  
  if (targetTemp) {
    const diff = Math.abs(temp - targetTemp);
    if (diff <= 5) {
      return '#10b981'; // Green - on target
    } else if (diff <= 15) {
      return '#f59e0b'; // Yellow - close
    } else {
      return '#ef4444'; // Red - far from target
    }
  }
  
  // Default color ranges for grill temperatures
  if (temp < 200) {
    return '#3b82f6'; // Blue - low
  } else if (temp < 250) {
    return '#10b981'; // Green - good
  } else if (temp < 300) {
    return '#f59e0b'; // Yellow - getting hot
  } else {
    return '#ef4444'; // Red - very hot
  }
}

/**
 * Temperature trend calculation
 */
export function calculateTrend(readings: Array<{ timestamp: string; temperature: number }>): 'rising' | 'falling' | 'stable' {
  if (readings.length < 2) {
    return 'stable';
  }
  
  const recent = readings.slice(-5); // Last 5 readings
  if (recent.length < 2) {
    return 'stable';
  }
  
  let risingCount = 0;
  let fallingCount = 0;
  
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i].temperature - recent[i - 1].temperature;
    if (diff > 1) {
      risingCount++;
    } else if (diff < -1) {
      fallingCount++;
    }
  }
  
  if (risingCount > fallingCount) {
    return 'rising';
  } else if (fallingCount > risingCount) {
    return 'falling';
  } else {
    return 'stable';
  }
}

/**
 * Calculates average temperature from readings
 */
export function calculateAverageTemperature(readings: Array<{ temperature: number }>): number {
  if (readings.length === 0) {
    return 0;
  }
  
  const sum = readings.reduce((total, reading) => total + reading.temperature, 0);
  return sum / readings.length;
}

/**
 * Applies temperature correction/calibration
 */
export function applyCorrectionOffset(temperature: number, offset: number): number {
  return temperature + offset;
}