// Panel ile paylasilan HATA KODU sozlesmesi (TEK KAYNAK).
//
// Panel bu kodlara gore DAVRANIR:
//   PD-409-STALE    -> panel damgayi tazeleyip sessizce tekrar dener (sahte cakisma)
//   PD-409-CONFLICT -> panel kullaniciya "hangi surum kalsin" diye sorar
//   PD-422-SCHEMA   -> panel otomatik tekrar denemez, sorunlu alani kullaniciya gosterir
//   AUTH-401        -> panel tekrar denemez (yapilandirma hatasi)
// Bu yuzden kodlar sessizce degistirilmemeli; degisirse panel tarafi da guncellenmeli.
// Kullanicinin bildirdigi kod, hatanin kaynagini tek noktaya indirger.

const CODES = {
  AUTH_401: 'AUTH-401',
  PD_400_NODATA: 'PD-400-NODATA',
  PD_400_BADINPUT: 'PD-400-BADINPUT',
  PD_422_SCHEMA: 'PD-422-SCHEMA',
  PD_409_CONFLICT: 'PD-409-CONFLICT',
  PD_409_STALE: 'PD-409-STALE',
  PD_500_READ: 'PD-500-READ',
  PD_500_WRITE: 'PD-500-WRITE',
  SD_400_NODATA: 'SD-400-NODATA',
  SD_500_READ: 'SD-500-READ',
  SD_500_WRITE: 'SD-500-WRITE',
};

// store.writePanelDataFull'un firlattigi hatayi HTTP durumu + panel koduna cevirir.
function panelWriteError(e) {
  if (e && e.code === 'CONFLICT') {
    return { status: 409, code: CODES.PD_409_CONFLICT, error: String(e.message), currentUpdatedAt: e.currentUpdatedAt || null };
  }
  if (e && e.code === 'STALE_WRITE') {
    return { status: 409, code: CODES.PD_409_STALE, error: String(e.message), currentUpdatedAt: e.currentUpdatedAt || null };
  }
  if (e && e.code === 'BAD_INPUT') {
    return { status: 400, code: CODES.PD_400_BADINPUT, error: String(e.message) };
  }
  return { status: 500, code: CODES.PD_500_WRITE, error: 'Panel verisi kaydedilemedi.' };
}

module.exports = { CODES, panelWriteError };
