package classificationrssops

import "strconv"

// itoa renders an integer the way JavaScript template interpolation does.
func itoa(value int) string {
	return strconv.Itoa(value)
}

// trimFloat renders a float64 with the shortest representation that round-trips,
// matching JavaScript's Number-to-string conversion used in the notification
// summaries.
func trimFloat(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}
