#!/bin/bash

# MeatGeek V2 Terraform Setup Script
# This script helps initialize Terraform with proper backend configuration

set -e  # Exit on any error

echo "🚀 MeatGeek V2 Terraform Setup"
echo "================================"

# Check prerequisites
command -v terraform >/dev/null 2>&1 || { echo "❌ Terraform not found. Please install Terraform first."; exit 1; }
command -v az >/dev/null 2>&1 || { echo "❌ Azure CLI not found. Please install Azure CLI first."; exit 1; }

echo "✅ Prerequisites check passed"

# Check Azure authentication
if ! az account show >/dev/null 2>&1; then
    echo "❌ Not authenticated with Azure. Please run: az login"
    exit 1
fi

echo "✅ Azure authentication verified"

# Get current directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "📂 Working directory: $SCRIPT_DIR"

# Option 1: Initialize with backend configuration file
if [ -f "backend-config.hcl" ]; then
    echo ""
    echo "🔧 Option 1: Initialize with backend configuration (Recommended for team/production)"
    echo "   This will store Terraform state in Azure Storage for collaboration"
    echo ""
    echo "   Please update backend-config.hcl with your actual storage account details:"
    echo "   - resource_group_name: Your storage account's resource group"
    echo "   - storage_account_name: Your storage account name"
    echo ""
    echo "   Then run: terraform init -backend-config=backend-config.hcl"
    echo ""
fi

# Option 2: Initialize with local backend
echo "🔧 Option 2: Initialize with local backend (For individual development)"
echo "   This stores state locally - good for initial testing"
echo ""
echo "   Run: terraform init"
echo ""

# Option 3: Initialize without backend
echo "🔧 Option 3: Validate configuration only"
echo "   This initializes providers without backend for validation"
echo ""
echo "   Run: terraform init -backend=false"
echo ""

echo "📋 After initialization, you can:"
echo "   • Validate: terraform validate"
echo "   • Format: terraform fmt -recursive"
echo "   • Plan: terraform plan -var-file=environments/dev.tfvars"
echo ""

echo "🎯 For MeatGeek V2 development, we recommend:"
echo "   1. Use local backend for initial testing"
echo "   2. Set up Azure Storage backend when ready for team collaboration"
echo ""

echo "⚙️  Environment files available:"
echo "   • environments/dev.tfvars     - Development environment"
echo "   • environments/staging.tfvars - Staging environment"
echo "   • environments/prod.tfvars    - Production environment"
echo ""

echo "Remember to update the CosmosDB account details in your chosen environment file!"