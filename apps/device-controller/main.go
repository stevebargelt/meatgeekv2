//go:build !testserver

package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"strconv"
	"time"

	dc_i2c "github.com/davecheney/i2c"
	queue "github.com/stevebargelt/meatgeekv2/apps/device-controller/goqueue"
	"github.com/stevebargelt/meatgeekv2/apps/device-controller/internal/deviceapi"
	"github.com/stevebargelt/meatgeekv2/apps/device-controller/internal/telemetry"

	"go.opentelemetry.io/otel"

	// Updated to gobot.io/x/gobot/v2 for Go 1.25 compatibility
	"gobot.io/x/gobot/v2"
	"gobot.io/x/gobot/v2/drivers/spi"
	"gobot.io/x/gobot/v2/platforms/raspi"
)

// smokerID is the device.id on telemetry and the smokerid get_status serves.
const smokerID = "meatgeek3"

// smoker is the state the hardware loop writes and the HTTP commands read.
var smoker = deviceapi.NewStore(deviceapi.Status{
    SmokerID: smokerID,
    AugerOn: false,
    TTL: 259200,
    BlowerOn: false,
    IgniterOn: false,
    FireHealthy: true,
    Mode: "test",
    SetPoint: 200,
})

func main() {

    // Re-add observability (MG-6). Telemetry is configured from the environment
    // (OTEL_EXPORTER_OTLP_ENDPOINT); an empty value runs a no-op exporter so
    // the controller works fully offline. device.id comes from the SmokerID.
    // The App Insights connection string lives only on the collector, which
    // fronts Azure Monitor; this edge service never reads it.
    shutdownTelemetry, err := telemetry.Setup(context.Background(), telemetry.ConfigFromEnv(smokerID))
    check(err)
    defer func() {
        shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        if err := shutdownTelemetry(shutdownCtx); err != nil {
            log.Printf("telemetry shutdown: %v", err)
        }
    }()

    manager := gobot.NewManager()

    // The HTTP surface (routes, commands, middleware) lives in
    // internal/deviceapi so it runs in tests without hardware (HAR-148). It
    // continues the W3C trace the data-pusher injects on get_status (MG-6),
    // answers a command request that has no body (the pusher's plain GET), and
    // turns a panic in any handler into a 500 instead of a dropped connection.
    handler := deviceapi.NewHandler(manager, deviceapi.Config{
        Tracer: otel.Tracer("device-controller"),
        Debug:  true,
    })
    go func() {
        server := &http.Server{
            Addr:              ":" + deviceapi.Port,
            Handler:           handler,
            ReadHeaderTimeout: 30 * time.Second,
        }
        log.Println("Initializing API on :" + deviceapi.Port + "...")
        log.Fatal(server.ListenAndServe())
    }()

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
            smoker.Update(func(s *deviceapi.Status) {
                s.Temps.GrillTemp = RTDs[0].temp
                s.Temps.Probe1Temp = RTDs[1].temp
                s.Temps.Probe2Temp = RTDs[2].temp
                s.Temps.Probe3Temp = RTDs[3].temp
                s.Temps.Probe4Temp = RTDs[4].temp
                s.CurrentTime = time.Now()
            })

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
    robot := deviceapi.NewRobot(smoker,
            []gobot.Connection{a},
            []gobot.Device{adc},
            work,
    )

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
