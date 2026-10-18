/** Degrees Fahrenheit for degrees Celsius. */
export function toFahrenheit(celsius) {
  return celsius * 9 / 5 + 32;
}

/** Kelvin for degrees Celsius; below absolute zero is a RangeError. */
export function toKelvin(celsius) {
  if (celsius < -273.15) throw new RangeError(`below absolute zero: ${celsius} C`);
  return celsius + 273.15;
}
