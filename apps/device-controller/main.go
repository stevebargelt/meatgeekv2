//go:build !testserver

package main

import (
	"context"
	"errors"
	"fmt"
	"html"
	"log"
	"math"
	"net/http"
	"strconv"
	"time"

	//using standard json with custom NaN handling
	"encoding/json"

	dc_i2c "github.com/davecheney/i2c"
	queue "github.com/stevebargelt/meatgeekv2/apps/device-controller/goqueue"
	"github.com/stevebargelt/meatgeekv2/apps/device-controller/internal/httptrace"
	"github.com/stevebargelt/meatgeekv2/apps/device-controller/internal/telemetry"

	"go.opentelemetry.io/otel"

	// Updated to gobot.io/x/gobot/v2 for Go 1.25 compatibility
	"gobot.io/x/gobot/v2"
	"gobot.io/x/gobot/v2/api"
	"gobot.io/x/gobot/v2/drivers/spi"
	"gobot.io/x/gobot/v2/platforms/raspi"
)

var SmokerStatus = Status {
    SmokerID: "meatgeek3",
    AugerOn: false,
    TTL: 259200,
    BlowerOn: false,
    IgniterOn: false, 
    FireHealthy: true,
    Mode: "test",
    SetPoint: 200,
}

func main() {

    // Re-add observability (MG-6). Telemetry is configured from the environment
    // (OTEL_EXPORTER_OTLP_ENDPOINT); an empty value runs a no-op exporter so
    // the controller works fully offline. device.id comes from the SmokerID.
    // The App Insights connection string lives only on the collector, which
    // fronts Azure Monitor; this edge service never reads it.
    shutdownTelemetry, err := telemetry.Setup(context.Background(), telemetry.ConfigFromEnv(SmokerStatus.SmokerID))
    check(err)
    defer func() {
        shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        if err := shutdownTelemetry(shutdownCtx); err != nil {
            log.Printf("telemetry shutdown: %v", err)
        }
    }()

    manager := gobot.NewManager()
    deviceApi := api.NewAPI(manager)
    deviceApi.Port = "3000"

    // Continue the W3C trace injected by the data-pusher collector on the
    // inbound get_status hop (MG-6). This gobot middleware runs per-request with
    // access to the raw *http.Request, extracts the `traceparent`, and opens a
    // server span parented to the upstream trace.
    deviceApi.AddHandler(httptrace.Middleware(otel.Tracer("device-controller")))

    deviceApi.AddHandler(func(w http.ResponseWriter, r *http.Request) {
    fmt.Fprintf(w, "Hello, %q \n", html.EscapeString(r.URL.Path))
    })
    deviceApi.Debug()
    deviceApi.Start()

    a := raspi.NewAdaptor()
    adc := spi.NewMCP3008Driver(a)

    i, err := dc_i2c.New(0x27, 1)
    check(err)
    lcd, err := dc_i2c.NewLcd(i, 2, 1, 0, 4, 5, 6, 7, 3)
    check(err)
    lcd.BacklightOn()
    lcd.Clear()
    lcd.Home()
    SetPosition(*lcd, 1, 0)
    fmt.Fprint(lcd, "MeatGeek Temp")
    SetPosition(*lcd, 2, 0)
    fmt.Fprint(lcd, "Line 2")
    SetPosition(*lcd, 3, 0)
    fmt.Fprint(lcd, "Line 3")
    SetPosition(*lcd, 4, 0)
    fmt.Fprint(lcd, "Line 4")

    RTDs := []*RTD{}
    for i := 0; i<5 ;i++ {
        rtd := new(RTD)
        rtd.title = "P" + strconv.Itoa(i)
        rtd.channel = i 
        rtd.resistanceQueue = *queue.New(100)
        RTDs = append(RTDs, rtd)
    }
    RTDs[0].title = "Grill"
    
    // Ahh yes magic numbers. Every RTD circuit can report resistances differently
    // these are the corrected values that I've observed for MY system and circuits. 
    // TODO: Allow these to be env vars and/or CLI flags. 
    RTDs[0].tempCorrection = -6.0
    RTDs[1].tempCorrection = -8.0
    RTDs[2].tempCorrection = 2.0
    RTDs[3].tempCorrection = -1.0
    RTDs[4].tempCorrection = -5.0

    work := func() {
        gobot.Every(10*time.Millisecond, func() {
        for _, rtd := range RTDs {
            result, err := adc.Read(rtd.channel)

            if err != nil {
                fmt.Println("ERROR: ", err.Error())
            }
            if result <=0 {
                //fmt.Printf("%s not connected. result = %d \n", rtd.title, result)
                rtd.resistanceQueue.Push(0)
            } else {
                var resistance = GetResistance(result)
                rtd.resistanceQueue.Push(resistance)
                //fmt.Printf("%s resistance %f\n", rtd.title, resistance)
            }
        } 

        })
        gobot.Every(5000*time.Millisecond, func() {
            for _, rtd := range RTDs {
                resAve := rtd.resistanceQueue.Average()
                fmt.Printf("%s resAverageQueue %f\n", rtd.title, resAve)
                if !math.IsNaN(resAve) && resAve > 0.0 {
                    rtd.temp = GetTempFahrenheitFromResistance(resAve) + rtd.tempCorrection
                    // fmt.Printf("%s Temp F %f\n", rtd.title, rtd.temp)
                    // SetPosition(*lcd, i, 0)
                    // fmt.Fprint(lcd, rtd.title,"Temp F ", math.Round(rtd.temp))
                } else {
                    // fmt.Printf("%s unplugged\n", rtd.title)
                    // SetPosition(*lcd, i, 0)
                    // fmt.Fprint(lcd, rtd.title, "Unplg")
                }
            }
            SmokerStatus.Temps.GrillTemp = RTDs[0].temp
            SmokerStatus.Temps.Probe1Temp = RTDs[1].temp
            SmokerStatus.Temps.Probe2Temp = RTDs[2].temp
            SmokerStatus.Temps.Probe3Temp = RTDs[3].temp
            SmokerStatus.Temps.Probe4Temp = RTDs[4].temp
            SmokerStatus.CurrentTime = time.Now()

            left := formatTemp(RTDs[1].title, RTDs[1].temp)
            right := formatTemp(RTDs[2].title, RTDs[2].temp)
            line := justifyWithSpaces(left, right, 20)
            fmt.Println(line)
            SetPosition(*lcd, 1, 0)
            fmt.Fprint(lcd, line)
            left = formatTemp(RTDs[3].title, RTDs[3].temp)
            right = formatTemp(RTDs[4].title, RTDs[4].temp)
            line = justifyWithSpaces(left, right, 20)
            fmt.Println(line)
            SetPosition(*lcd, 2, 0)
            fmt.Fprint(lcd, justifyWithSpaces(left, right, 20))
            SetPosition(*lcd, 3, 0)
            fmt.Fprint(lcd, formatTemp(RTDs[0].title, RTDs[0].temp))
            fmt.Println(formatTemp(RTDs[0].title, RTDs[0].temp))
            SetPosition(*lcd, 4, 0)
            t := time.Now()
            fmt.Fprint(lcd, t.Format("Mon Jan 2 15:04"))
        })                
    }
    robot := gobot.NewRobot("MeatGeekBot",
            []gobot.Connection{a},
            []gobot.Device{adc},
            work,
    )
    robot.AddCommand("get_temps", func(params map[string]interface{}) interface{} {
        res, err := json.Marshal(SmokerStatus.Temps)
        if err != nil {
            fmt.Println("ERROR: ", err.Error())
        }
        return string(res)
    })

    robot.AddCommand("get_status", func(params map[string]interface{}) interface{} {
        res, err := json.Marshal(SmokerStatus)
        if err != nil {
            fmt.Println("ERROR: ", err.Error())
        }
        return string(res)
    })

    manager.AddRobot(robot)
    if err := manager.Start(); err != nil {
        log.Fatal(err)
    }
}


func GetResistance(adcValue int) (float64) {
    var rtdV float64 = (float64(adcValue) / 1023) * 3.3
    R := ((3.3 * 1000) - (rtdV * 1000)) / rtdV
    return R
}

func GetTempFahrenheitFromResistance(resistance float64) (float64) {
    // fmt.Printf("GetTempFahrenheitFromResistance: resistance=%f\n", resistance)
    var A float64 = 3.90830e-3 // Coefficient A
    var B float64 = -5.775e-7 // Coefficient B
    var ReferenceResistor float64 = 1000
    var TempCelsius float64 = (-A + math.Sqrt(A * A - 4 * B * (1 - resistance / ReferenceResistor))) / (2 * B);
    return TempCelsius * 9 / 5 + 32;
}

///RTD is a Resisteance Temperature Detector
type RTD struct {  
    title string
    channel int
    resistanceQueue queue.Queue
    tempCorrection float64
    temp float64
}

func check(err error) {
	if err != nil { log.Fatal(err) }
}

// I had to rewrite the SetPosition becuase the original from the Dave Cheney 
// wasn't working with my hardware. I will investigate at some point. For now,
// this works... 
func SetPosition(lcd dc_i2c.Lcd, top, left int) (err error) {
    const CMD_DDRAM_Set = 0x80
    ErrInvalidPosition := errors.New("invalid position value")
    rowOffsets := []int{ 0, 64, 20, 84 }
    rows := 4

    if top < 1 || top > 4 {
		err = ErrInvalidPosition
		return
	}
    if left < 0 || left > 39 {
		err = ErrInvalidPosition
		return
	}
    var newAddress = left + rowOffsets[top-1];
    if left < 0 || (rows == 1 && newAddress >= 80) || (rows > 1 && newAddress >=104) {
        err = ErrInvalidPosition
        return
    }

	lcd.Command(byte(CMD_DDRAM_Set | newAddress))
    return nil
}

func justifyWithSpaces(string1, string2 string, maxChars int) (string) {
    if len(string1) + len(string2) > maxChars {
        if len(string1) > 10 {
            string1 = string1[0:9]
        }
        if len(string2) > 10 {
            string2 = string2[0:9]
        }
    }
    spacesCount := maxChars - len(string2)
    return (fmt.Sprintf("%-*v%v", spacesCount, string1, string2))
}

func formatTemp(title string, temp float64) (string) {
    if temp > 0.0 {
        return fmt.Sprintf("%s %.0f F", title, math.Round(temp))
    } else {
        return fmt.Sprintf("%s unplg", title)
    }
}

type Temps struct {
	GrillTemp  float64 `json:"grillTemp"`
	Probe1Temp float64 `json:"probe1Temp"`
	Probe2Temp float64 `json:"probe2Temp"`
	Probe3Temp float64 `json:"probe3Temp"`
	Probe4Temp float64 `json:"probe4Temp"`
}

type Status struct {
	ID           string     `json:"id"`
	TTL          int        `json:"ttl"`
	SmokerID     string     `json:"smokerid"`
    Type         string     `json:"type"`
	AugerOn      bool       `json:"augerOn"`
	BlowerOn     bool       `json:"blowerOn"`
	IgniterOn    bool       `json:"igniterOn"`
	Temps        Temps      `json:"temps"`
	FireHealthy  bool       `json:"fireHealthy"`
	Mode         string     `json:"mode"`
	SetPoint     int        `json:"setPoint"`
	ModeTime     time.Time  `json:"modeTime"`
	CurrentTime  time.Time  `json:"currentTime"`
}

// MarshalJSON handles NaN values for Temps
func (t Temps) MarshalJSON() ([]byte, error) {
	type Alias Temps
	temp := struct {
		GrillTemp  interface{} `json:"grillTemp"`
		Probe1Temp interface{} `json:"probe1Temp"`
		Probe2Temp interface{} `json:"probe2Temp"`
		Probe3Temp interface{} `json:"probe3Temp"`
		Probe4Temp interface{} `json:"probe4Temp"`
		Alias
	}{
		Alias: Alias(t),
	}
	
	// Convert NaN values to null or string representation
	temp.GrillTemp = handleNaN(t.GrillTemp)
	temp.Probe1Temp = handleNaN(t.Probe1Temp)
	temp.Probe2Temp = handleNaN(t.Probe2Temp)
	temp.Probe3Temp = handleNaN(t.Probe3Temp)
	temp.Probe4Temp = handleNaN(t.Probe4Temp)
	
	return json.Marshal(temp)
}

// handleNaN converts NaN to null for JSON compatibility
func handleNaN(val float64) interface{} {
	if math.IsNaN(val) || math.IsInf(val, 0) {
		return nil // Will serialize as null
	}
	return val
}