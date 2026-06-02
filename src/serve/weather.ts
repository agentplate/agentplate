/**
 * Weather widget data via Open-Meteo (free, no API key).
 *
 * Geocodes a location name → lat/lon, then fetches current conditions + a 3-day
 * forecast. Best-effort: on any network/parse failure returns `available:false`
 * so the UI can hide or stub the widget. Results are cached briefly to avoid
 * hammering the API from the 5s snapshot loop (the widget is polled, not pushed).
 */

const DEFAULT_LOCATION = process.env.AGENTPLATE_WEATHER_LOCATION || "Madrid";

export interface WeatherDay {
	date: string;
	tempMax: number;
	tempMin: number;
	code: number;
}

export interface Weather {
	available: boolean;
	location: string;
	tempC: number | null;
	feelsLikeC: number | null;
	humidity: number | null;
	windKmh: number | null;
	code: number | null;
	description: string;
	forecast: WeatherDay[];
}

const WMO: Record<number, string> = {
	0: "Clear sky",
	1: "Mainly clear",
	2: "Partly cloudy",
	3: "Overcast",
	45: "Fog",
	48: "Rime fog",
	51: "Light drizzle",
	61: "Light rain",
	63: "Rain",
	65: "Heavy rain",
	71: "Light snow",
	73: "Snow",
	80: "Rain showers",
	95: "Thunderstorm",
};

function describe(code: number | null): string {
	return code != null ? (WMO[code] ?? "—") : "—";
}

interface CacheEntry {
	at: number;
	value: Weather;
}
const cache = new Map<string, CacheEntry>();
const TTL_MS = 10 * 60 * 1000; // 10 minutes

const empty = (location: string): Weather => ({
	available: false,
	location,
	tempC: null,
	feelsLikeC: null,
	humidity: null,
	windKmh: null,
	code: null,
	description: "—",
	forecast: [],
});

/** Fetch current weather + forecast for a location (cached ~10 min). */
export async function fetchWeather(loc?: string | null): Promise<Weather> {
	const location = loc?.trim() || DEFAULT_LOCATION;
	const cached = cache.get(location);
	if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

	try {
		// 1. Geocode.
		const geoRes = await fetch(
			`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`,
		);
		const geo = (await geoRes.json()) as {
			results?: Array<{ latitude: number; longitude: number; name: string }>;
		};
		const place = geo.results?.[0];
		if (!place) {
			const v = empty(location);
			cache.set(location, { at: Date.now(), value: v });
			return v;
		}

		// 2. Current + daily forecast.
		const wxRes = await fetch(
			`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
				`&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
				`&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=3&timezone=auto`,
		);
		const wx = (await wxRes.json()) as {
			current?: {
				temperature_2m: number;
				apparent_temperature: number;
				relative_humidity_2m: number;
				weather_code: number;
				wind_speed_10m: number;
			};
			daily?: {
				time: string[];
				weather_code: number[];
				temperature_2m_max: number[];
				temperature_2m_min: number[];
			};
		};
		const cur = wx.current;
		const daily = wx.daily;
		const forecast: WeatherDay[] = daily
			? daily.time.map((date, i) => ({
					date,
					tempMax: Math.round(daily.temperature_2m_max[i] ?? 0),
					tempMin: Math.round(daily.temperature_2m_min[i] ?? 0),
					code: daily.weather_code[i] ?? 0,
				}))
			: [];

		const value: Weather = {
			available: Boolean(cur),
			location: place.name,
			tempC: cur ? Math.round(cur.temperature_2m) : null,
			feelsLikeC: cur ? Math.round(cur.apparent_temperature) : null,
			humidity: cur ? Math.round(cur.relative_humidity_2m) : null,
			windKmh: cur ? Math.round(cur.wind_speed_10m) : null,
			code: cur ? cur.weather_code : null,
			description: describe(cur?.weather_code ?? null),
			forecast,
		};
		cache.set(location, { at: Date.now(), value });
		return value;
	} catch {
		return empty(location);
	}
}
