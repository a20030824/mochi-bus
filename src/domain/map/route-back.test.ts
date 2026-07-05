import { describe, expect, it } from 'vitest'
import { routeLoadingBack, routeViewBack } from './route-back'

describe('routeLoadingBack', () => {
  it('行程候選進來的,載入中退回行程候選', () => {
    expect(routeLoadingBack({ returnToTrip: true, hasStopBackAction: false }))
      .toEqual({ target: 'trip-results', label: '返回行程候選' })
    // 行程優先於站點退路
    expect(routeLoadingBack({ returnToTrip: true, hasStopBackAction: true }).target).toBe('trip-results')
  })

  it('站牌路線清單進來的,退回站點', () => {
    expect(routeLoadingBack({ returnToTrip: false, hasStopBackAction: true }))
      .toEqual({ target: 'stop-view', label: '返回站點' })
  })

  it('路線列表進來的,退回路線列表', () => {
    expect(routeLoadingBack({ returnToTrip: false, hasStopBackAction: false }))
      .toEqual({ target: 'route-picker', label: '返回路線' })
  })
})

describe('routeViewBack', () => {
  it('行程候選還在:退回行程候選', () => {
    expect(routeViewBack({
      returnToTrip: true, hasTripResults: true, canReturnToVariantPicker: false, hasStopBackAction: false,
    })).toEqual({ target: 'trip-results', label: '返回行程候選' })
  })

  it('行程候選已被丟棄:標籤不變,實際退路降級到站點或路線列表', () => {
    expect(routeViewBack({
      returnToTrip: true, hasTripResults: false, canReturnToVariantPicker: false, hasStopBackAction: true,
    })).toEqual({ target: 'stop-view', label: '返回行程候選' })
    expect(routeViewBack({
      returnToTrip: true, hasTripResults: false, canReturnToVariantPicker: false, hasStopBackAction: false,
    })).toEqual({ target: 'route-picker', label: '返回行程候選' })
  })

  it('經支線選擇進來:退回支線選擇(一層),不能直接跳回路線列表(兩層)', () => {
    expect(routeViewBack({
      returnToTrip: false, hasTripResults: false, canReturnToVariantPicker: true, hasStopBackAction: false,
    })).toEqual({ target: 'variant-picker', label: '更換方向' })
  })

  it('站牌路線清單進來:退回站點', () => {
    expect(routeViewBack({
      returnToTrip: false, hasTripResults: false, canReturnToVariantPicker: false, hasStopBackAction: true,
    })).toEqual({ target: 'stop-view', label: '返回站點' })
  })

  it('路線列表進來:更換路線', () => {
    expect(routeViewBack({
      returnToTrip: false, hasTripResults: false, canReturnToVariantPicker: false, hasStopBackAction: false,
    })).toEqual({ target: 'route-picker', label: '更換路線' })
  })
})
