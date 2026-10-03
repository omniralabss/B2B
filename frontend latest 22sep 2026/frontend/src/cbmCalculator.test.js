import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AIR_DIMENSIONAL_DIVISOR,
  DEFAULT_SEA_VOLUMETRIC_FACTOR_KG_PER_CBM,
  DIMENSION_CONVERSION_FACTORS,
  calculateActualWeight,
  calculateAirVolumetricWeight,
  calculateCbm,
  calculateCbmMetrics,
  calculateChargeableAirWeight,
  calculateSeaVolumetricWeight,
  estimateContainerCartons,
  normalizeDimensionToMeters,
} from './cbmCalculator.js';

describe('CBM calculator conversions', () => {
  it('normalizes common unit values to meters', () => {
    expect(normalizeDimensionToMeters(100, 'cm')).toBeCloseTo(1, 12);
    expect(normalizeDimensionToMeters(1, 'm')).toBeCloseTo(1, 12);
    expect(normalizeDimensionToMeters(1000, 'mm')).toBeCloseTo(1, 12);
    expect(normalizeDimensionToMeters(39.37007874015748, 'inch')).toBeCloseTo(1, 12);
    expect(normalizeDimensionToMeters(3.280839895013123, 'ft')).toBeCloseTo(1, 12);
  });

  it('calculates the reference case exactly for 100x54x30 cm', () => {
    const result = calculateCbmMetrics({
      length: 100,
      width: 54,
      height: 30,
      unit: 'cm',
      weightPerCarton: '',
      weightUnit: 'kg',
      quantity: 1,
    });

    expect(result.cbmPerCarton).toBeCloseTo(0.162, 12);
    expect(result.totalCbm).toBeCloseTo(0.162, 12);
    expect(result.cubicFeet).toBeCloseTo(5.721, 3);
    expect(result.actualWeightKg).toBeCloseTo(0, 12);
    expect(result.actualWeightLb).toBeCloseTo(0, 12);
    expect(result.seaVolumetricWeightKg).toBeCloseTo(32.4, 12);
    expect(result.seaVolumetricWeightLb).toBeCloseTo(71.43, 2);
    expect(result.airVolumetricWeightKg).toBeCloseTo(27, 12);
    expect(result.airVolumetricWeightLb).toBeCloseTo(59.525, 3);
    expect(result.containerEstimates.twentyFt).toBe(174);
    expect(result.containerEstimates.fortyFt).toBe(368);
    expect(result.containerEstimates.fortyFtHighCube).toBe(419);
  });

  it('handles decimal dimensions and multi-carton quantities', () => {
    const result = calculateCbmMetrics({
      length: 12.5,
      width: 10.2,
      height: 8.4,
      unit: 'cm',
      weightPerCarton: 3.5,
      weightUnit: 'kg',
      quantity: 4,
    });

    expect(result.cbmPerCarton).toBeCloseTo(0.001071, 9);
    expect(result.totalCbm).toBeCloseTo(0.004284, 9);
    expect(result.actualWeightKg).toBeCloseTo(14, 12);
    expect(result.actualWeightLb).toBeCloseTo(30.864, 2);
    expect(result.chargeableAirWeightKg).toBeGreaterThanOrEqual(result.actualWeightKg);
    expect(result.chargeableAirWeightKg).toBeGreaterThanOrEqual(result.airVolumetricWeightKg);
  });

  it('converts weight between kilograms and pounds correctly', () => {
    const kgResult = calculateActualWeight({ weightPerCarton: 10, weightUnit: 'kg', quantity: 3 });
    const lbResult = calculateActualWeight({ weightPerCarton: 10, weightUnit: 'lb', quantity: 3 });

    expect(kgResult.totalActualWeightKg).toBeCloseTo(30, 12);
    expect(kgResult.totalActualWeightLb).toBeCloseTo(66.138, 2);
    expect(lbResult.totalActualWeightKg).toBeCloseTo(13.607, 2);
    expect(lbResult.totalActualWeightLb).toBeCloseTo(30, 12);
  });

  it('keeps invalid or empty values from producing invalid math', () => {
    expect(calculateCbm({ length: '', width: 'abc', height: '-5', unit: 'cm', quantity: '0' })).toMatchObject({
      cbmPerCarton: 0,
      totalCbm: 0,
      quantity: 0,
    });
    expect(calculateSeaVolumetricWeight({ totalCbm: 0 })).toMatchObject({
      seaVolumetricWeightKg: 0,
      seaVolumetricWeightLb: 0,
    });
    expect(calculateAirVolumetricWeight({ length: '', width: '', height: '', unit: 'cm', quantity: '', totalCbm: 0 })).toMatchObject({
      airVolumetricWeightKg: 0,
      airVolumetricWeightLb: 0,
    });
    expect(calculateChargeableAirWeight({ totalActualWeightKg: 0, airVolumetricWeightKg: 0 })).toMatchObject({
      chargeableAirWeightKg: 0,
      chargeableAirWeightLb: 0,
    });
  });

  it('estimates container carton capacity from usable CBM values', () => {
    expect(estimateContainerCartons({ cbmPerCarton: 0.162 })).toMatchObject({
      twentyFt: 174,
      fortyFt: 368,
      fortyFtHighCube: 419,
    });
  });

  it('uses the expected defaults for sea and air volumetric calculations', () => {
    expect(DEFAULT_SEA_VOLUMETRIC_FACTOR_KG_PER_CBM).toBe(200);
    expect(DEFAULT_AIR_DIMENSIONAL_DIVISOR).toBe(6000);
    expect(DIMENSION_CONVERSION_FACTORS.cm).toBe(0.01);
    expect(DIMENSION_CONVERSION_FACTORS.m).toBe(1);
    expect(DIMENSION_CONVERSION_FACTORS.mm).toBe(0.001);
    expect(DIMENSION_CONVERSION_FACTORS.inch).toBe(0.0254);
    expect(DIMENSION_CONVERSION_FACTORS.ft).toBe(0.3048);
  });
});
