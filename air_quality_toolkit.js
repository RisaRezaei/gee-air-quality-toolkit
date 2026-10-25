/**
 * Air-Quality Toolkit (Sentinel-5P + MODIS MAIAC)
 * -----------------------------------------------
 * Monthly air-quality indicators for a city or region and for a set of
 * monitoring stations, for several pollutants at once:
 *   NO2, SO2, HCHO (Sentinel-5P tropospheric / total columns),
 *   CO, O3 (Sentinel-5P total columns) and AOD (MODIS MAIAC, 470 nm).
 *
 * Outputs
 *   - One chart per pollutant: monthly mean over the region and at stations.
 *   - Map layers: mean of the whole period for each pollutant.
 *   - CSV (long format): pollutant, unit, site, month, value, n_images.
 *   - Optional GeoTIFF of every monthly mean map.
 *
 * How to run
 *   Paste into https://code.earthengine.google.com, edit CONFIG, press Run,
 *   then start the exports from the Tasks tab.
 *
 * Author: Parisa Abbasalizadehrezaei · https://risarezaei.github.io
 * License: MIT
 */

// =============================== CONFIG ===================================
var CONFIG = {
  // Region for the regional mean and the maps (example: Tehran).
  region: ee.Geometry.Rectangle([50.95, 35.50, 51.70, 35.90]),

  // Stations: [name, longitude, latitude]. Use [] for region only.
  stations: [
    ['Station_A', 51.389, 35.689],
    ['Station_B', 51.338, 35.744],
    ['Station_C', 51.480, 35.660]
  ],
  stationBufferMeters: 2000,       // radius averaged around each station

  start: '2019-01-01',             // inclusive
  end: '2026-01-01',               // exclusive

  // Any of: 'NO2', 'SO2', 'CO', 'O3', 'HCHO', 'AOD'
  pollutants: ['NO2', 'SO2', 'CO', 'O3', 'HCHO', 'AOD'],

  exportTable: true,
  exportMonthlyMaps: false,        // one GeoTIFF per pollutant and month
  driveFolder: 'earthengine',
  filePrefix: 'air_quality'
};
// ==========================================================================

// Dataset, band, factor to a readable unit, unit label, scale (m), map range.
var PRODUCTS = {
  NO2:  {id: 'COPERNICUS/S5P/OFFL/L3_NO2', band: 'tropospheric_NO2_column_number_density',
         factor: 1e6, unit: 'µmol/m²', scale: 1113.2, vis: [50, 600]},
  SO2:  {id: 'COPERNICUS/S5P/OFFL/L3_SO2', band: 'SO2_column_number_density',
         factor: 1e6, unit: 'µmol/m²', scale: 1113.2, vis: [0, 300]},
  CO:   {id: 'COPERNICUS/S5P/OFFL/L3_CO', band: 'CO_column_number_density',
         factor: 1e3, unit: 'mmol/m²', scale: 1113.2, vis: [25, 45]},
  O3:   {id: 'COPERNICUS/S5P/OFFL/L3_O3', band: 'O3_column_number_density',
         factor: 1e3, unit: 'mmol/m²', scale: 1113.2, vis: [110, 160]},
  HCHO: {id: 'COPERNICUS/S5P/OFFL/L3_HCHO', band: 'tropospheric_HCHO_column_number_density',
         factor: 1e6, unit: 'µmol/m²', scale: 1113.2, vis: [0, 250]},
  AOD:  {id: 'MODIS/061/MCD19A2_GRANULES', band: 'Optical_Depth_047',
         factor: 0.001, unit: 'AOD (470 nm)', scale: 1000, vis: [0, 0.6]}
};
var PALETTE = ['0d0887', '5302a3', '8b0aa5', 'b83289', 'db5c68', 'f48849', 'febd2a', 'f0f921'];

var region = CONFIG.region;
var start = ee.Date(CONFIG.start), end = ee.Date(CONFIG.end);
var nMonths = end.difference(start, 'month').round();
var monthStarts = ee.List.sequence(0, nMonths.subtract(1)).map(function (i) {
  return start.advance(i, 'month');
});

var stations = ee.FeatureCollection(CONFIG.stations.map(function (s) {
  return ee.Feature(ee.Geometry.Point([s[1], s[2]]).buffer(CONFIG.stationBufferMeters), {site: s[0]});
}));
var sites = ee.FeatureCollection([ee.Feature(region, {site: 'region'})]).merge(stations);

function collection(key) {
  var p = PRODUCTS[key];
  return ee.ImageCollection(p.id).filterBounds(region).filterDate(start, end)
    .select([p.band], [key])
    .map(function (img) {
      return img.multiply(p.factor).copyProperties(img, ['system:time_start']);
    });
}

// Monthly mean image; months without data become fully masked images.
function monthly(key) {
  var col = collection(key);
  return ee.ImageCollection(monthStarts.map(function (d) {
    d = ee.Date(d);
    var sub = col.filterDate(d, d.advance(1, 'month'));
    var img = ee.Image(ee.Algorithms.If(sub.size().gt(0), sub.mean(),
      ee.Image.constant(0).rename(key).updateMask(0)));
    return img.set({'system:time_start': d.millis(), month: d.format('YYYY-MM'),
                    n_images: sub.size()});
  }));
}

// Long-format table: one row per pollutant, site and month.
function table(key) {
  var p = PRODUCTS[key];
  return monthly(key).map(function (img) {
    return img.reduceRegions({collection: sites, reducer: ee.Reducer.mean(),
                              scale: p.scale, tileScale: 4})
      .map(function (f) {
        return f.setGeometry(null).set({
          pollutant: key, unit: p.unit, month: img.get('month'),
          n_images: img.get('n_images'), value: f.get('mean')
        });
      });
  }).flatten();
}

Map.centerObject(region, 10);
var all = ee.FeatureCollection([]);

CONFIG.pollutants.forEach(function (key, i) {
  var p = PRODUCTS[key];
  var t = table(key);
  all = all.merge(t);

  Map.addLayer(collection(key).mean().clip(region),
    {min: p.vis[0], max: p.vis[1], palette: PALETTE},
    key + ' mean ' + CONFIG.start.slice(0, 4) + '-' + CONFIG.end.slice(0, 4), i === 0, 0.8);

  print(ui.Chart.feature.groups({
    features: t.filter(ee.Filter.notNull(['value'])).map(function (f) {
      return f.set('t', ee.Date.parse('YYYY-MM', f.get('month')).millis());
    }),
    xProperty: 't', yProperty: 'value', seriesProperty: 'site'
  }).setChartType('LineChart').setOptions({
    title: key + ' monthly mean (' + p.unit + ')',
    hAxis: {title: 'Month', format: 'yyyy'}, vAxis: {title: p.unit},
    lineWidth: 1.5, pointSize: 2, interpolateNulls: false
  }));

  if (CONFIG.exportMonthlyMaps) {
    // The month list is built on the client so no server round trip is needed.
    var d = new Date(CONFIG.start + 'T00:00:00Z');
    var stop = new Date(CONFIG.end + 'T00:00:00Z');
    var col = collection(key);
    while (d < stop) {
      var m0 = ee.Date(d.getTime());
      var label = d.toISOString().slice(0, 7);
      Export.image.toDrive({
        image: col.filterDate(m0, m0.advance(1, 'month')).mean().toFloat(),
        description: CONFIG.filePrefix + '_' + key + '_' + label.replace('-', '_'),
        folder: CONFIG.driveFolder, region: region, scale: p.scale, maxPixels: 1e13
      });
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
  }
});

Map.addLayer(ee.Image().paint(region, 0, 2), {palette: ['ffffff']}, 'Region');
Map.addLayer(stations, {color: '4fd1c5'}, 'Stations');

if (CONFIG.exportTable) {
  Export.table.toDrive({
    collection: all, description: CONFIG.filePrefix + '_monthly',
    folder: CONFIG.driveFolder, fileFormat: 'CSV',
    selectors: ['pollutant', 'unit', 'site', 'month', 'value', 'n_images']
  });
}
