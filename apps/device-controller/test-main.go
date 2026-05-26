package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

// Mock temperature data for testing
type TemperatureResponse struct {
	Temps struct {
		GrillTemp  *float64 `json:"grillTemp"`
		Probe1Temp *float64 `json:"probe1Temp"`
		Probe2Temp *float64 `json:"probe2Temp"`
		Probe3Temp *float64 `json:"probe3Temp"`
		Probe4Temp *float64 `json:"probe4Temp"`
	} `json:"temps"`
	Status struct {
		SmokerID    string `json:"smokerid"`
		AugerOn     bool   `json:"augerOn"`
		BlowerOn    bool   `json:"blowerOn"`
		IgniterOn   bool   `json:"igniterOn"`
		FireHealthy bool   `json:"fireHealthy"`
		Mode        string `json:"mode"`
		SetPoint    int    `json:"setPoint"`
		CurrentTime string `json:"currentTime"`
	} `json:"status"`
}

func main() {
	fmt.Println("🚀 MeatGeek Device Controller Test Build")
	fmt.Printf("Version: %s\n", getVersion())
	fmt.Printf("Build Time: %s\n", getBuildTime())
	
	// Start mock API server
	http.HandleFunc("/api/robots/MeatGeekBot/commands/get_status", getStatusHandler)
	http.HandleFunc("/api/robots/MeatGeekBot/commands/get_temps", getTempsHandler)
	http.HandleFunc("/health", healthHandler)
	
	fmt.Println("🌡️  Mock temperature API started on http://localhost:3000")
	fmt.Println("   Available endpoints:")
	fmt.Println("   - GET /api/robots/MeatGeekBot/commands/get_status")
	fmt.Println("   - GET /api/robots/MeatGeekBot/commands/get_temps") 
	fmt.Println("   - GET /health")
	
	log.Fatal(http.ListenAndServe(":3000", nil))
}

func getStatusHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	
	// Generate mock temperature data
	grillTemp := 225.0 + (float64(time.Now().Unix()%20) - 10) // 215-235°F
	probe1Temp := 165.0 + (float64(time.Now().Unix()%10) - 5) // 160-170°F
	probe2Temp := 145.0 + (float64(time.Now().Unix()%8) - 4)  // 141-149°F
	
	response := TemperatureResponse{}
	response.Temps.GrillTemp = &grillTemp
	response.Temps.Probe1Temp = &probe1Temp
	response.Temps.Probe2Temp = &probe2Temp
	response.Temps.Probe3Temp = nil // Probe 3 not connected
	response.Temps.Probe4Temp = nil // Probe 4 not connected
	
	response.Status.SmokerID = "meatgeek3"
	response.Status.AugerOn = false
	response.Status.BlowerOn = false
	response.Status.IgniterOn = false
	response.Status.FireHealthy = true
	response.Status.Mode = "test"
	response.Status.SetPoint = 225
	response.Status.CurrentTime = time.Now().UTC().Format(time.RFC3339)
	
	if err := json.NewEncoder(w).Encode(response); err != nil {
		http.Error(w, "Failed to encode response", http.StatusInternalServerError)
	}
}

func getTempsHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	
	// Generate mock temperature data (temps only)
	grillTemp := 225.0 + (float64(time.Now().Unix()%20) - 10)
	probe1Temp := 165.0 + (float64(time.Now().Unix()%10) - 5)
	probe2Temp := 145.0 + (float64(time.Now().Unix()%8) - 4)
	
	temps := struct {
		Temps struct {
			GrillTemp  *float64 `json:"grillTemp"`
			Probe1Temp *float64 `json:"probe1Temp"`
			Probe2Temp *float64 `json:"probe2Temp"`
			Probe3Temp *float64 `json:"probe3Temp"`
			Probe4Temp *float64 `json:"probe4Temp"`
		} `json:"temps"`
	}{}
	
	temps.Temps.GrillTemp = &grillTemp
	temps.Temps.Probe1Temp = &probe1Temp
	temps.Temps.Probe2Temp = &probe2Temp
	temps.Temps.Probe3Temp = nil
	temps.Temps.Probe4Temp = nil
	
	if err := json.NewEncoder(w).Encode(temps); err != nil {
		http.Error(w, "Failed to encode response", http.StatusInternalServerError)
	}
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	
	health := map[string]interface{}{
		"status":    "healthy",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"version":   getVersion(),
		"uptime":    time.Since(time.Now()).Seconds(),
		"service":   "device-controller-test",
	}
	
	if err := json.NewEncoder(w).Encode(health); err != nil {
		http.Error(w, "Failed to encode response", http.StatusInternalServerError)
	}
}

func getVersion() string {
	return "test-build"
}

func getBuildTime() string {
	return time.Now().Format("2006-01-02_15:04:05")
}